import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { parse } from 'yaml';
import { captureRepositorySet } from '../evidence/checkout-snapshot.js';
import { canonicalDigest } from '../model/digest.js';
import { validateDocument } from '../policy/load.js';
import { validateHardenedTaskContract } from '../policy/task-contract.js';
import { readTaskLedger } from '../state/ledger.js';
import { governanceIdentity } from './adopt.js';
function sha256(input) {
    return createHash('sha256').update(input).digest('hex');
}
function normalizeReplaySnapshots(snapshots, taskId) {
    const ignored = new Set([
        `.delivery/tasks/${taskId}/replay-plan.json`,
        `.delivery/tasks/${taskId}/replay-verification.json`,
    ]);
    return snapshots.map((snapshot) => {
        const untracked = snapshot.untracked.filter((item) => !ignored.has(item.path));
        return {
            ...snapshot,
            untracked,
            statusDigest: canonicalDigest({
                trackedDiffSha256: snapshot.trackedDiffSha256,
                trackedPaths: snapshot.trackedPaths,
                untracked,
            }),
        };
    });
}
function replayCheckoutSnapshots(repositories, taskId) {
    return normalizeReplaySnapshots(captureRepositorySet(repositories), taskId);
}
function safeFile(pathInput, label) {
    const unresolved = resolve(pathInput);
    if (!existsSync(unresolved) || lstatSync(unresolved).isSymbolicLink() || !lstatSync(unresolved).isFile()) {
        throw new Error(`${label}_ARTIFACT_UNSAFE`);
    }
    const path = realpathSync(unresolved);
    return { path, raw: readFileSync(path) };
}
function loadCandidate(candidatePathInput, requireCandidateState = true) {
    const candidateArtifact = safeFile(candidatePathInput, 'CANDIDATE');
    const candidate = parse(candidateArtifact.raw.toString('utf8'));
    const candidateSchema = validateDocument('candidate', candidate);
    if (!candidateSchema.valid || candidate.schemaVersion !== 2)
        throw new Error('CANDIDATE_SCHEMA_INVALID');
    const taskDirectory = dirname(candidateArtifact.path);
    if (candidateArtifact.path !== join(taskDirectory, 'candidate.yaml')) {
        throw new Error('CANDIDATE_CANONICAL_PATH_MISMATCH');
    }
    const projectRoot = realpathSync(resolve(taskDirectory, '../../..'));
    const relativeTask = relative(projectRoot, taskDirectory);
    if (relativeTask !== `.delivery/tasks/${candidate.taskId}`)
        throw new Error('CANDIDATE_TASK_DIRECTORY_MISMATCH');
    const contractArtifact = safeFile(candidate.contract.path, 'CONTRACT');
    if (contractArtifact.path !== join(taskDirectory, 'contract.yaml')) {
        throw new Error('CONTRACT_CANONICAL_PATH_MISMATCH');
    }
    if (sha256(contractArtifact.raw) !== candidate.contract.sha256) {
        throw new Error('CONTRACT_ARTIFACT_DIGEST_MISMATCH');
    }
    const contract = parse(contractArtifact.raw.toString('utf8'));
    const validation = validateHardenedTaskContract(contract);
    if (!validation.valid)
        throw new Error(`CONTRACT_INVALID:${validation.errors.join(',')}`);
    if (candidate.taskId !== contract.taskId)
        throw new Error('CANDIDATE_TASK_ID_MISMATCH');
    const ledger = readTaskLedger({
        projectRoot,
        taskId: contract.taskId,
        contractDigest: contract.contractDigest,
        contractSha256: candidate.contract.sha256,
        implementationOwner: contract.implementationOwner,
    });
    if (!ledger.valid || (requireCandidateState && ledger.currentState !== 'CANDIDATE')) {
        throw new Error(`TASK_NOT_REPLAYABLE:${ledger.currentState ?? 'INVALID'}`);
    }
    return {
        candidate,
        candidatePath: candidateArtifact.path,
        candidateRaw: candidateArtifact.raw,
        contract,
        contractPath: contractArtifact.path,
        contractRaw: contractArtifact.raw,
        projectRoot,
    };
}
function replayPlanForLoaded(loaded, checkoutSnapshots) {
    const requiredGates = loaded.contract.acceptance.filter((gate) => gate.observerPolicy.replay === 'required');
    if (requiredGates.length === 0)
        throw new Error('REPLAY_NOT_REQUIRED');
    const gates = requiredGates.map((gate) => {
        const repository = loaded.contract.repositories.find((item) => item.id === gate.command.repositoryId);
        if (repository === undefined)
            throw new Error(`REPLAY_REPOSITORY_UNKNOWN:${gate.id}`);
        const cwd = realpathSync(resolve(repository.path, gate.command.cwd));
        const relativeCwd = relative(repository.path, cwd);
        if (relativeCwd.startsWith('..') || isAbsolute(relativeCwd))
            throw new Error(`REPLAY_CWD_OUTSIDE_REPOSITORY:${gate.id}`);
        return {
            acceptanceId: gate.id,
            gateDigest: canonicalDigest(gate),
            command: {
                executable: gate.command.executable,
                executableSha256: gate.command.executableSha256,
                arguments: [...gate.command.arguments],
                cwd,
                environment: { ...gate.command.environment },
            },
            observerPolicy: { ...gate.observerPolicy },
        };
    });
    const unsigned = {
        schemaVersion: 2,
        artifactType: 'sop-replay-plan-v2',
        projectRoot: loaded.projectRoot,
        taskId: loaded.contract.taskId,
        contract: {
            path: loaded.contractPath,
            sha256: sha256(loaded.contractRaw),
            digest: loaded.contract.contractDigest,
        },
        candidate: {
            path: loaded.candidatePath,
            sha256: sha256(loaded.candidateRaw),
            digest: canonicalDigest(loaded.candidate),
        },
        implementationIdentities: loaded.candidate.implementationIdentities,
        checkoutSnapshots,
        gates,
    };
    return { ...unsigned, digest: canonicalDigest(unsigned) };
}
export function planCandidateReplay(candidatePath) {
    const loaded = loadCandidate(candidatePath);
    return replayPlanForLoaded(loaded, replayCheckoutSnapshots(loaded.contract.repositories, loaded.contract.taskId));
}
function executeGate(plan, gate, repositories) {
    const policyErrors = [];
    if (sha256(readFileSync(gate.command.executable)) !== gate.command.executableSha256) {
        throw new Error(`REPLAY_EXECUTABLE_DIGEST_MISMATCH:${gate.acceptanceId}`);
    }
    const repositoriesBefore = captureRepositorySet(repositories);
    const startedAt = new Date().toISOString();
    const result = spawnSync(gate.command.executable, gate.command.arguments, {
        cwd: gate.command.cwd,
        encoding: 'utf8',
        env: gate.command.environment,
        maxBuffer: 64 * 1024 * 1024,
        shell: false,
    });
    const endedAt = new Date().toISOString();
    const stdout = result.stdout ?? '';
    const stderr = result.stderr ?? result.error?.message ?? '';
    const exitCode = result.status ?? 70;
    const repositoriesAfter = captureRepositorySet(repositories);
    if (exitCode !== gate.observerPolicy.expectedExitCode)
        policyErrors.push('REPLAY_EXIT_CODE_MISMATCH');
    if (gate.observerPolicy.output === 'nonempty' && stdout.length === 0 && stderr.length === 0) {
        policyErrors.push('REPLAY_OUTPUT_EMPTY');
    }
    if (gate.observerPolicy.output === 'exact') {
        if (sha256(stdout) !== gate.observerPolicy.expectedStdoutSha256)
            policyErrors.push('REPLAY_STDOUT_EXACT_MISMATCH');
        if (sha256(stderr) !== gate.observerPolicy.expectedStderrSha256)
            policyErrors.push('REPLAY_STDERR_EXACT_MISMATCH');
    }
    if (JSON.stringify(repositoriesBefore) !== JSON.stringify(repositoriesAfter)) {
        policyErrors.push('REPLAY_CHECKOUT_MUTATED');
    }
    return {
        acceptanceId: gate.acceptanceId,
        gateDigest: gate.gateDigest,
        command: gate.command,
        repositoriesBefore,
        repositoriesAfter,
        startedAt,
        endedAt,
        exitCode,
        stdout,
        stderr,
        stdoutSha256: sha256(stdout),
        stderrSha256: sha256(stderr),
        policyErrors,
    };
}
export function applyCandidateReplay(plan, approvedDigest) {
    const { digest, ...unsigned } = plan;
    if (approvedDigest !== digest || canonicalDigest(unsigned) !== digest) {
        throw new Error('REPLAY_PLAN_DIGEST_MISMATCH');
    }
    const currentPlan = planCandidateReplay(plan.candidate.path);
    if (canonicalDigest(currentPlan) !== canonicalDigest(plan))
        throw new Error('REPLAY_PLAN_DRIFTED');
    const loaded = loadCandidate(plan.candidate.path);
    const planPath = join(dirname(loaded.candidatePath), 'replay-plan.json');
    const outputPath = join(dirname(loaded.candidatePath), 'replay-verification.json');
    if (existsSync(planPath))
        throw new Error('REPLAY_APPROVED_PLAN_ALREADY_EXISTS');
    if (existsSync(outputPath))
        throw new Error('REPLAY_VERIFICATION_ALREADY_EXISTS');
    writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`, { flag: 'wx', mode: 0o644 });
    const executions = plan.gates.map((gate) => executeGate(plan, gate, loaded.contract.repositories));
    const firstSnapshots = executions[0]?.repositoriesBefore;
    if (firstSnapshots === undefined || JSON.stringify(normalizeReplaySnapshots(firstSnapshots, loaded.contract.taskId)) !== JSON.stringify(plan.checkoutSnapshots)) {
        throw new Error('REPLAY_CHECKOUT_DRIFTED');
    }
    const identity = governanceIdentity();
    const artifact = {
        schemaVersion: 2,
        artifactType: 'sop-replay-verification-v2',
        producer: { name: '@xgh/engineering-governance', version: identity.version, policyDigest: identity.digest },
        taskId: plan.taskId,
        contract: plan.contract,
        candidate: plan.candidate,
        planDigest: plan.digest,
        implementationIdentities: plan.implementationIdentities,
        executions,
        verifiedAt: new Date().toISOString(),
        decision: executions.every((execution) => execution.policyErrors.length === 0) ? 'eligible' : 'failed',
    };
    const schema = validateDocument('replay-verification', artifact);
    if (!schema.valid)
        throw new Error(`REPLAY_VERIFICATION_SCHEMA_INVALID:${schema.errors.join(',')}`);
    const content = `${JSON.stringify(artifact, null, 2)}\n`;
    writeFileSync(outputPath, content, { flag: 'wx', mode: 0o644 });
    return { path: outputPath, sha256: sha256(content), artifact };
}
function sameIdentities(left, right) {
    const canonical = (values) => [...values]
        .sort((a, b) => a.repositoryId.localeCompare(b.repositoryId));
    return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}
function approvedReplayPlan(loaded) {
    const planPath = join(dirname(loaded.candidatePath), 'replay-plan.json');
    if (!existsSync(planPath))
        throw new Error('REPLAY_APPROVED_PLAN_REQUIRED');
    let plan;
    try {
        const file = safeFile(planPath, 'REPLAY_APPROVED_PLAN');
        plan = JSON.parse(file.raw.toString('utf8'));
    }
    catch {
        throw new Error('REPLAY_APPROVED_PLAN_INVALID');
    }
    if (plan.schemaVersion !== 2
        || plan.artifactType !== 'sop-replay-plan-v2'
        || !Array.isArray(plan.checkoutSnapshots)
        || plan.checkoutSnapshots.length === 0
        || !Array.isArray(plan.gates)
        || plan.gates.length === 0
        || typeof plan.digest !== 'string')
        throw new Error('REPLAY_APPROVED_PLAN_INVALID');
    const { digest, ...unsigned } = plan;
    if (canonicalDigest(unsigned) !== digest)
        throw new Error('REPLAY_APPROVED_PLAN_INVALID');
    const current = replayPlanForLoaded(loaded, plan.checkoutSnapshots);
    if (canonicalDigest(current) !== canonicalDigest(plan))
        throw new Error('REPLAY_APPROVED_PLAN_DRIFTED');
    return plan;
}
export function verifyCandidateReplay(candidatePath, verificationTime, maximumAgeMs, runnerIdentity) {
    const loaded = loadCandidate(candidatePath, false);
    const outputPath = join(dirname(loaded.candidatePath), 'replay-verification.json');
    const required = loaded.contract.acceptance.some((gate) => gate.observerPolicy.replay === 'required');
    if (!required) {
        return existsSync(outputPath) ? { errors: ['REPLAY_PROHIBITED_OR_UNBOUND'] } : { errors: [] };
    }
    if (!existsSync(outputPath)) {
        const plan = replayPlanForLoaded(loaded, replayCheckoutSnapshots(loaded.contract.repositories, loaded.contract.taskId));
        return { errors: [`EVIDENCE_REPLAY_APPROVAL_REQUIRED:${plan.digest}`] };
    }
    let artifact;
    let raw;
    try {
        const file = safeFile(outputPath, 'REPLAY_VERIFICATION');
        raw = file.raw;
        artifact = JSON.parse(raw.toString('utf8'));
    }
    catch {
        return { errors: ['REPLAY_VERIFICATION_UNREADABLE'] };
    }
    const errors = [];
    const schema = validateDocument('replay-verification', artifact);
    if (!schema.valid)
        return { errors: schema.errors.map((error) => `REPLAY_VERIFICATION_SCHEMA_INVALID:${error}`) };
    const firstExecution = artifact.executions[0];
    if (firstExecution === undefined)
        return { errors: ['REPLAY_EXECUTION_SET_MISMATCH'] };
    let plan;
    try {
        plan = approvedReplayPlan(loaded);
    }
    catch (error) {
        return { errors: [error instanceof Error ? error.message : 'REPLAY_APPROVED_PLAN_INVALID'] };
    }
    const approvedSnapshots = plan.checkoutSnapshots;
    const executionSnapshots = normalizeReplaySnapshots(firstExecution.repositoriesBefore, loaded.contract.taskId);
    const identity = runnerIdentity ?? governanceIdentity();
    if (artifact.producer.version !== identity.version || artifact.producer.policyDigest !== identity.digest) {
        errors.push('REPLAY_RUNNER_IDENTITY_MISMATCH');
    }
    if (artifact.taskId !== plan.taskId || artifact.planDigest !== plan.digest
        || JSON.stringify(artifact.contract) !== JSON.stringify(plan.contract)
        || JSON.stringify(artifact.candidate) !== JSON.stringify(plan.candidate)) {
        errors.push('REPLAY_PLAN_BINDING_MISMATCH');
    }
    if (artifact.planDigest !== plan.digest)
        errors.push('REPLAY_APPROVED_PLAN_REQUIRED');
    if (!sameIdentities(artifact.implementationIdentities, plan.implementationIdentities)) {
        errors.push('REPLAY_IMPLEMENTATION_IDENTITY_MISMATCH');
    }
    if (JSON.stringify(executionSnapshots) !== JSON.stringify(approvedSnapshots)) {
        errors.push('REPLAY_APPROVED_CHECKOUT_MISMATCH');
    }
    const replayRepositories = firstExecution.repositoriesBefore.map((snapshot) => ({
        repositoryId: snapshot.id,
        repository: snapshot.repository,
    })).sort((left, right) => left.repositoryId.localeCompare(right.repositoryId));
    const candidateRepositories = plan.implementationIdentities.map((candidate) => ({
        repositoryId: candidate.repositoryId,
        repository: candidate.repository,
    })).sort((left, right) => left.repositoryId.localeCompare(right.repositoryId));
    if (JSON.stringify(replayRepositories) !== JSON.stringify(candidateRepositories)) {
        errors.push('REPLAY_REPOSITORY_SET_MISMATCH');
    }
    if (artifact.executions.length !== plan.gates.length)
        errors.push('REPLAY_EXECUTION_SET_MISMATCH');
    for (const [index, gate] of plan.gates.entries()) {
        const execution = artifact.executions[index];
        if (execution === undefined || execution.acceptanceId !== gate.acceptanceId
            || execution.gateDigest !== gate.gateDigest
            || JSON.stringify(execution.command) !== JSON.stringify(gate.command)) {
            errors.push(`REPLAY_EXECUTION_BINDING_MISMATCH:${gate.acceptanceId}`);
            continue;
        }
        if (sha256(execution.stdout) !== execution.stdoutSha256
            || sha256(execution.stderr) !== execution.stderrSha256) {
            errors.push(`REPLAY_OUTPUT_DIGEST_MISMATCH:${gate.acceptanceId}`);
        }
        const recomputedPolicyErrors = [];
        if (execution.exitCode !== gate.observerPolicy.expectedExitCode) {
            errors.push(`REPLAY_EXIT_CODE_MISMATCH:${gate.acceptanceId}`);
            recomputedPolicyErrors.push('REPLAY_EXIT_CODE_MISMATCH');
        }
        if (gate.observerPolicy.output === 'nonempty'
            && execution.stdout.length === 0
            && execution.stderr.length === 0) {
            errors.push(`REPLAY_OUTPUT_POLICY_MISMATCH:${gate.acceptanceId}`);
            recomputedPolicyErrors.push('REPLAY_OUTPUT_EMPTY');
        }
        if (gate.observerPolicy.output === 'exact' && (sha256(execution.stdout) !== gate.observerPolicy.expectedStdoutSha256
            || sha256(execution.stderr) !== gate.observerPolicy.expectedStderrSha256)) {
            errors.push(`REPLAY_OUTPUT_POLICY_MISMATCH:${gate.acceptanceId}`);
            if (sha256(execution.stdout) !== gate.observerPolicy.expectedStdoutSha256) {
                recomputedPolicyErrors.push('REPLAY_STDOUT_EXACT_MISMATCH');
            }
            if (sha256(execution.stderr) !== gate.observerPolicy.expectedStderrSha256) {
                recomputedPolicyErrors.push('REPLAY_STDERR_EXACT_MISMATCH');
            }
        }
        if (JSON.stringify(execution.policyErrors) !== JSON.stringify(recomputedPolicyErrors)) {
            errors.push(`REPLAY_POLICY_RESULT_MISMATCH:${gate.acceptanceId}`);
        }
        if (execution.policyErrors.length > 0) {
            errors.push(...execution.policyErrors.map((error) => `REPLAY_POLICY_ERROR:${gate.acceptanceId}:${error}`));
        }
        if (JSON.stringify(execution.repositoriesBefore) !== JSON.stringify(execution.repositoriesAfter)) {
            errors.push(`REPLAY_CHECKOUT_MUTATED:${gate.acceptanceId}`);
        }
    }
    const verifiedAt = Date.parse(artifact.verifiedAt);
    const age = verificationTime.getTime() - verifiedAt;
    if (!Number.isFinite(verifiedAt) || age < 0 || age > maximumAgeMs)
        errors.push('REPLAY_VERIFICATION_TIME_INVALID');
    if (artifact.decision !== 'eligible')
        errors.push('REPLAY_VERIFICATION_FAILED');
    return {
        errors: [...new Set(errors)].sort(),
        ...(errors.length === 0 ? { reference: { path: outputPath, sha256: sha256(raw), planDigest: plan.digest } } : {}),
    };
}
