import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { stringify } from 'yaml';
import { canonicalDigest } from '../model/digest.js';
import { normalizeActorId } from '../model/actor.js';
import { classifyRisk, highestRisk } from '../policy/risk.js';
import { validateHardenedTaskContract } from '../policy/task-contract.js';
import { initialTaskEvent } from '../state/ledger.js';
import { captureCheckoutSnapshot } from '../evidence/checkout-snapshot.js';
import { externalSourceExtensionId, externalSourceExtensionVersion, externalSourceMinimumRisk, validateExternalSourceTaskInput, } from '../extensions/external-source.js';
import { governanceIdentity } from './adopt.js';
export function taskContractDigest(input) {
    return canonicalDigest(input);
}
function sha256(input) {
    return createHash('sha256').update(input).digest('hex');
}
function sha256Bytes(input) {
    return createHash('sha256').update(input).digest('hex');
}
function resolvedExecutable(input) {
    if (input.trim().length === 0)
        throw new Error('TASK_GATE_EXECUTABLE_REQUIRED');
    let unresolved = input;
    if (!isAbsolute(unresolved)) {
        try {
            unresolved = execFileSync('/usr/bin/which', [unresolved], {
                encoding: 'utf8',
                env: { PATH: process.env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin' },
                stdio: ['ignore', 'pipe', 'ignore'],
            }).trim();
        }
        catch {
            throw new Error(`TASK_GATE_EXECUTABLE_NOT_FOUND:${input}`);
        }
    }
    const path = realpathSync(resolve(unresolved));
    if (!lstatSync(path).isFile())
        throw new Error(`TASK_GATE_EXECUTABLE_UNSAFE:${input}`);
    return { path, sha256: sha256Bytes(readFileSync(path)) };
}
function frozenEnvironment(input) {
    const environment = input ?? {
        PATH: `${dirname(realpathSync(process.execPath))}:/usr/bin:/bin:/usr/sbin:/sbin`,
    };
    for (const [key, value] of Object.entries(environment)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) || typeof value !== 'string' || value.includes('\0')) {
            throw new Error(`TASK_GATE_ENVIRONMENT_INVALID:${key}`);
        }
    }
    return Object.fromEntries(Object.entries(environment).sort(([left], [right]) => left.localeCompare(right)));
}
function canonicalRepositories(repositories) {
    const ids = repositories.map((repository) => repository.id);
    if (new Set(ids).size !== ids.length)
        throw new Error('TASK_REPOSITORY_IDS_DUPLICATED');
    const canonical = repositories.map((repository) => {
        const path = realpathSync(resolve(repository.path));
        const snapshot = captureCheckoutSnapshot({ id: repository.id, path });
        return {
            id: repository.id,
            path,
            baseline: {
                head: snapshot.head,
                tree: snapshot.tree,
                checkoutDigest: canonicalDigest(snapshot),
                trackedPaths: snapshot.trackedPaths,
                untrackedPaths: snapshot.untracked.map((item) => item.path),
            },
        };
    });
    if (new Set(canonical.map((repository) => repository.path)).size !== canonical.length) {
        throw new Error('TASK_REPOSITORY_PATHS_DUPLICATED');
    }
    return canonical;
}
function validateAcceptanceCommands(acceptance, repositories) {
    const acceptanceIds = acceptance.map((item) => item.id);
    if (new Set(acceptanceIds).size !== acceptanceIds.length) {
        throw new Error('TASK_ACCEPTANCE_IDS_DUPLICATED');
    }
    const repositoryById = new Map(repositories.map((repository) => [repository.id, repository.path]));
    for (const item of acceptance) {
        const repository = repositoryById.get(item.command.repositoryId);
        if (repository === undefined) {
            throw new Error(`TASK_GATE_REPOSITORY_UNKNOWN:${item.id}`);
        }
        if (isAbsolute(item.command.cwd)) {
            throw new Error(`TASK_GATE_CWD_MUST_BE_RELATIVE:${item.id}`);
        }
        const cwd = resolve(repository, item.command.cwd);
        const relativePath = relative(repository, cwd);
        if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
            throw new Error(`TASK_GATE_CWD_OUTSIDE_REPOSITORY:${item.id}`);
        }
    }
}
export function startTask(input, context = {}) {
    if (input.schemaVersion !== 2) {
        throw new Error('ACTIVE_COMMAND_REQUIRES_SCHEMA_VERSION_2');
    }
    let risk = classifyRisk(input.signals);
    if (risk === 'R0')
        return { risk, state: 'DEFINED', artifacts: [] };
    const identity = governanceIdentity();
    const implementationOwner = normalizeActorId(input.implementationOwner);
    const repositories = canonicalRepositories(input.repositories);
    validateAcceptanceCommands(input.acceptance, repositories);
    const acceptance = input.acceptance.map((gate) => {
        const executable = resolvedExecutable(gate.command.executable);
        return {
            ...gate,
            command: {
                ...gate.command,
                executable: executable.path,
                executableSha256: executable.sha256,
                environment: frozenEnvironment(gate.command.environment),
            },
        };
    });
    const projectExtensions = context.projectExtensions ?? [];
    const extensionKeys = projectExtensions.map((extension) => `${extension.id}@${extension.version}`);
    if (new Set(extensionKeys).size !== extensionKeys.length)
        throw new Error('TASK_EXTENSIONS_DUPLICATED');
    const providedInputs = input.extensionInputs ?? {};
    for (const key of Object.keys(providedInputs)) {
        if (!extensionKeys.includes(key))
            throw new Error(`TASK_EXTENSION_INPUT_UNBOUND:${key}`);
    }
    const extensions = projectExtensions.map((extension) => {
        const key = `${extension.id}@${extension.version}`;
        let extensionInput = providedInputs[key];
        if (extension.id === externalSourceExtensionId && extension.version === externalSourceExtensionVersion) {
            const validatedInput = validateExternalSourceTaskInput(extensionInput ?? { mode: 'independent' });
            extensionInput = validatedInput;
            const minimum = externalSourceMinimumRisk(validatedInput);
            if (minimum !== undefined)
                risk = highestRisk([risk, minimum]);
        }
        else if (extensionInput === undefined) {
            extensionInput = {};
        }
        return { id: extension.id, version: extension.version, digest: extension.digest, input: extensionInput };
    });
    const evidenceFreshnessMs = input.evidenceFreshnessMs ?? 86_400_000;
    if (!Number.isInteger(evidenceFreshnessMs) || evidenceFreshnessMs < 1 || evidenceFreshnessMs > 86_400_000) {
        throw new Error('TASK_EVIDENCE_FRESHNESS_INVALID');
    }
    const contractPath = `.delivery/tasks/${input.taskId}/contract.yaml`;
    const unsigned = {
        schemaVersion: 2,
        taskId: input.taskId,
        sopVersion: identity.version,
        policyDigest: identity.digest,
        risk,
        riskSignals: input.signals,
        implementationOwner,
        objective: input.objective,
        scope: input.scope,
        nonGoals: input.nonGoals,
        authorityInputs: input.authorityInputs,
        repositories,
        acceptance,
        evidenceFreshnessMs,
        authorizationRequirements: input.authorizationRequirements,
        extensions,
        openChoices: input.openChoices,
    };
    const contract = { ...unsigned, contractDigest: taskContractDigest(unsigned) };
    const semantic = validateHardenedTaskContract(contract);
    if (!semantic.valid)
        throw new Error(semantic.errors.join(','));
    const contractContent = stringify(contract);
    const event = initialTaskEvent({
        actorId: implementationOwner,
        contractDigest: contract.contractDigest,
        contractPath,
        contractSha256: sha256(contractContent),
    });
    return {
        risk,
        state: 'DEFINED',
        artifacts: [
            { path: contractPath, content: contractContent },
            {
                path: `.delivery/tasks/${input.taskId}/ledger.jsonl`,
                content: `${JSON.stringify(event)}\n`,
            },
        ],
    };
}
export function planTaskStart(projectPath, input, context = {}) {
    const projectRoot = realpathSync(resolve(projectPath));
    const result = startTask(input, context);
    const unsigned = {
        schemaVersion: 2,
        artifactType: 'sop-task-start-plan-v2',
        projectRoot,
        taskId: input.taskId,
        ...result,
        artifacts: result.artifacts.map((artifact) => ({
            path: join(projectRoot, artifact.path),
            content: artifact.content,
        })),
    };
    return { ...unsigned, digest: canonicalDigest(unsigned) };
}
function assertSafeTaskTarget(projectRoot, path) {
    const relativePath = relative(projectRoot, path);
    if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
        throw new Error(`TASK_START_TARGET_OUTSIDE_PROJECT:${path}`);
    }
    let current = projectRoot;
    for (const segment of relativePath.split('/').slice(0, -1)) {
        current = join(current, segment);
        if (existsSync(current) && (lstatSync(current).isSymbolicLink() || !lstatSync(current).isDirectory())) {
            throw new Error(`TASK_START_TARGET_PARENT_UNSAFE:${current}`);
        }
    }
    if (existsSync(path))
        throw new Error(`TASK_START_TARGET_EXISTS:${path}`);
}
export function applyTaskStart(plan, reviewedDigest) {
    const { digest, ...unsigned } = plan;
    if (reviewedDigest !== digest || canonicalDigest(unsigned) !== digest) {
        throw new Error('TASK_START_PLAN_DIGEST_MISMATCH');
    }
    for (const artifact of plan.artifacts)
        assertSafeTaskTarget(plan.projectRoot, artifact.path);
    const applied = [];
    try {
        for (const artifact of plan.artifacts) {
            mkdirSync(dirname(artifact.path), { recursive: true });
            writeFileSync(artifact.path, artifact.content, { flag: 'wx', mode: 0o644 });
            applied.push(artifact.path);
        }
    }
    catch (error) {
        for (const path of applied.reverse())
            unlinkSync(path);
        throw error;
    }
    return { applied };
}
