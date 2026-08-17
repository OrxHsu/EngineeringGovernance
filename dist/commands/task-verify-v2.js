import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { parse } from 'yaml';
import { governanceIdentity } from './adopt.js';
import { isRemediationBridgeContract, remediationBridgeErrors } from '../accountability/enforce.js';
import { verifyGitIdentity } from '../evidence/git-identity.js';
import { canonicalDigest } from '../model/digest.js';
import { implementationOwnersOf, primaryImplementationOwner } from '../model/ownership.js';
import { validateDocument } from '../policy/load.js';
import { validateHardenedTaskContract } from '../policy/task-contract.js';
import { readTaskLedger } from '../state/ledger.js';
import { extensionDescriptor } from '../extensions/registry.js';
import { externalSourceExtensionId, externalSourceExtensionVersion, verifyExternalSourceArtifacts, } from '../extensions/external-source.js';
import { verifyCandidateReplay } from './task-replay-v2.js';
function sha256(input) {
    return createHash('sha256').update(input).digest('hex');
}
function readArtifact(reference, label) {
    const unresolved = resolve(reference.path);
    if (lstatSync(unresolved).isSymbolicLink() || !lstatSync(unresolved).isFile()) {
        throw new Error(`${label}_ARTIFACT_UNSAFE`);
    }
    const path = realpathSync(unresolved);
    const raw = readFileSync(path);
    if (sha256(raw) !== reference.sha256)
        throw new Error(`${label}_ARTIFACT_DIGEST_MISMATCH`);
    return { path, raw, value: parse(raw.toString('utf8')) };
}
function canonicalIdentities(values) {
    return [...values].sort((left, right) => left.repositoryId.localeCompare(right.repositoryId));
}
function sameIdentities(left, right) {
    return JSON.stringify(canonicalIdentities(left)) === JSON.stringify(canonicalIdentities(right));
}
function expectedCommand(gate, contract) {
    const repository = contract.repositories.find((candidate) => candidate.id === gate.command.repositoryId);
    if (repository === undefined)
        return undefined;
    return {
        executable: gate.command.executable,
        executableSha256: gate.command.executableSha256,
        arguments: gate.command.arguments,
        cwd: realpathSync(resolve(repository.path, gate.command.cwd)),
        environment: gate.command.environment,
    };
}
function receiptErrors(input) {
    const { receipt, gate, contract, evidence, identities } = input;
    const prefix = receipt.acceptanceId;
    const errors = [];
    const schema = validateDocument('execution-receipt', receipt);
    if (!schema.valid)
        return schema.errors.map((error) => `RECEIPT_SCHEMA_INVALID:${prefix}:${error}`);
    if (receipt.producer.version !== input.runnerIdentity.version
        || receipt.producer.policyDigest !== input.runnerIdentity.digest) {
        errors.push(`RECEIPT_RUNNER_IDENTITY_MISMATCH:${prefix}`);
    }
    if (receipt.acceptanceId !== gate.id)
        errors.push(`RECEIPT_ACCEPTANCE_ID_MISMATCH:${prefix}`);
    if (receipt.taskId !== contract.taskId)
        errors.push(`RECEIPT_TASK_MISMATCH:${prefix}`);
    if (receipt.contract.digest !== contract.contractDigest
        || receipt.contract.path !== input.contractArtifact.path
        || receipt.contract.sha256 !== input.contractArtifact.sha256)
        errors.push(`RECEIPT_CONTRACT_MISMATCH:${prefix}`);
    if (receipt.runId !== evidence.runId)
        errors.push(`RECEIPT_RUN_MISMATCH:${prefix}`);
    if (receipt.gateDigest !== canonicalDigest(gate))
        errors.push(`RECEIPT_GATE_MISMATCH:${prefix}`);
    if (receipt.evidenceKind !== gate.evidenceKind)
        errors.push(`RECEIPT_EVIDENCE_KIND_MISMATCH:${prefix}`);
    const command = expectedCommand(gate, contract);
    if (command === undefined || JSON.stringify(receipt.command) !== JSON.stringify(command)) {
        errors.push(`RECEIPT_COMMAND_MISMATCH:${prefix}`);
    }
    try {
        if (sha256(readFileSync(receipt.command.executable)) !== receipt.command.executableSha256) {
            errors.push(`RECEIPT_EXECUTABLE_DIGEST_MISMATCH:${prefix}`);
        }
    }
    catch {
        errors.push(`RECEIPT_EXECUTABLE_UNREADABLE:${prefix}`);
    }
    if (receipt.exitCode !== gate.observerPolicy.expectedExitCode) {
        errors.push(`RECEIPT_EXIT_MISMATCH:${prefix}`);
    }
    if (gate.observerPolicy.output === 'nonempty'
        && receipt.stdout.length === 0
        && receipt.stderr.length === 0)
        errors.push(`RECEIPT_OUTPUT_EMPTY:${prefix}`);
    if (gate.observerPolicy.output === 'exact') {
        if (receipt.stdoutSha256 !== gate.observerPolicy.expectedStdoutSha256) {
            errors.push(`RECEIPT_STDOUT_EXACT_MISMATCH:${prefix}`);
        }
        if (receipt.stderrSha256 !== gate.observerPolicy.expectedStderrSha256) {
            errors.push(`RECEIPT_STDERR_EXACT_MISMATCH:${prefix}`);
        }
    }
    if (sha256(receipt.stdout) !== receipt.stdoutSha256)
        errors.push(`RECEIPT_STDOUT_DIGEST_MISMATCH:${prefix}`);
    if (sha256(receipt.stderr) !== receipt.stderrSha256)
        errors.push(`RECEIPT_STDERR_DIGEST_MISMATCH:${prefix}`);
    if (receipt.policyErrors.length > 0)
        errors.push(...receipt.policyErrors.map((error) => (`RECEIPT_POLICY_ERROR:${prefix}:${error}`)));
    if (JSON.stringify(receipt.repositoriesBefore) !== JSON.stringify(receipt.repositoriesAfter)) {
        errors.push(`RECEIPT_CHECKOUT_MUTATED:${prefix}`);
    }
    const snapshotIdentities = receipt.repositoriesBefore.map((snapshot) => ({
        repositoryId: snapshot.id,
        repository: snapshot.repository,
        commit: snapshot.head,
        tree: snapshot.tree,
        checkoutDigest: canonicalDigest(snapshot),
    }));
    if (!sameIdentities(snapshotIdentities, identities)) {
        errors.push(`RECEIPT_IMPLEMENTATION_IDENTITY_MISMATCH:${prefix}`);
    }
    const startedAt = Date.parse(receipt.startedAt);
    const endedAt = Date.parse(receipt.endedAt);
    const age = input.verificationTime.getTime() - endedAt;
    if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt) || startedAt > endedAt) {
        errors.push(`RECEIPT_TIME_INVALID:${prefix}`);
    }
    else if (age < 0)
        errors.push(`RECEIPT_TIME_IN_FUTURE:${prefix}`);
    else if (age > input.maxEvidenceAgeMs)
        errors.push(`RECEIPT_STALE:${prefix}`);
    return errors;
}
function containedArtifact(root, path) {
    const realRoot = realpathSync(root);
    const unresolved = resolve(realRoot, path);
    if (lstatSync(unresolved).isSymbolicLink() || !lstatSync(unresolved).isFile()) {
        throw new Error('RECEIPT_ARTIFACT_UNSAFE');
    }
    const candidate = realpathSync(unresolved);
    const relativePath = relative(realRoot, candidate);
    if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
        throw new Error('RECEIPT_ARTIFACT_OUTSIDE_ROOT');
    }
    return candidate;
}
function sameStringSet(left, right) {
    const canonical = (values) => [...new Set(values)].sort();
    return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}
function changedPaths(contract, identities) {
    const paths = [];
    const errors = [];
    for (const repository of contract.repositories) {
        const identity = identities.find((candidate) => candidate.repositoryId === repository.id);
        if (identity === undefined)
            continue;
        try {
            execFileSync('git', [
                '-C',
                repository.path,
                'merge-base',
                '--is-ancestor',
                repository.baseline.head,
                identity.commit,
            ], { stdio: ['ignore', 'ignore', 'ignore'] });
        }
        catch {
            errors.push(`IMPLEMENTATION_NOT_DESCENDED_FROM_BASELINE:${repository.id}`);
            continue;
        }
        const baselineTree = execFileSync('git', [
            '-C', repository.path, 'rev-parse', `${repository.baseline.head}^{tree}`,
        ], { encoding: 'utf8' }).trim();
        if (baselineTree !== repository.baseline.tree)
            errors.push(`BASELINE_TREE_MISMATCH:${repository.id}`);
        const output = execFileSync('git', [
            '-C',
            repository.path,
            'diff',
            '--name-only',
            '-z',
            `${repository.baseline.head}..${identity.commit}`,
            '--',
        ]);
        for (const path of output.toString('utf8').split('\0').filter(Boolean).sort()) {
            if (!path.startsWith('.delivery/'))
                paths.push({ repositoryId: repository.id, path });
        }
    }
    return { paths, errors };
}
function authorizationErrors(input) {
    const errors = [];
    const trust = [];
    const expectedIds = input.contract.authorizationRequirements.map((requirement) => requirement.id);
    const actualIds = input.references.map((reference) => reference.requirementId);
    if (new Set(expectedIds).size !== expectedIds.length)
        errors.push('AUTHORIZATION_REQUIREMENT_IDS_DUPLICATED');
    if (new Set(actualIds).size !== actualIds.length)
        errors.push('AUTHORIZATION_ARTIFACT_IDS_DUPLICATED');
    if (JSON.stringify([...expectedIds].sort()) !== JSON.stringify([...actualIds].sort())) {
        errors.push('AUTHORIZATION_ARTIFACT_SET_MISMATCH');
    }
    for (const requirement of input.contract.authorizationRequirements) {
        const reference = input.references.find((item) => item.requirementId === requirement.id);
        if (reference === undefined)
            continue;
        let path;
        let raw;
        let authorization;
        try {
            path = containedArtifact(input.projectRoot, reference.path);
            if (path !== join(input.taskDirectory, 'authorizations', `${requirement.id}.json`)) {
                errors.push(`AUTHORIZATION_CANONICAL_PATH_MISMATCH:${requirement.id}`);
                continue;
            }
            raw = readFileSync(path);
            if (sha256(raw) !== reference.sha256) {
                errors.push(`AUTHORIZATION_ARTIFACT_DIGEST_MISMATCH:${requirement.id}`);
                continue;
            }
            authorization = JSON.parse(raw.toString('utf8'));
        }
        catch {
            errors.push(`AUTHORIZATION_ARTIFACT_UNREADABLE:${requirement.id}`);
            continue;
        }
        const schema = validateDocument('authorization', authorization);
        if (!schema.valid || authorization.schemaVersion !== 2 || authorization.artifactType !== 'sop-authorization-v2') {
            errors.push(`AUTHORIZATION_SCHEMA_INVALID:${requirement.id}`);
            continue;
        }
        if (authorization.requirementId !== requirement.id) {
            errors.push(`AUTHORIZATION_REQUIREMENT_MISMATCH:${requirement.id}`);
        }
        if (authorization.taskId !== input.contract.taskId) {
            errors.push(`AUTHORIZATION_TASK_MISMATCH:${requirement.id}`);
        }
        if (authorization.contractDigest !== input.contract.contractDigest) {
            errors.push(`AUTHORIZATION_CONTRACT_MISMATCH:${requirement.id}`);
        }
        if (authorization.action !== requirement.action)
            errors.push(`AUTHORIZATION_ACTION_MISMATCH:${requirement.id}`);
        if (authorization.target !== requirement.target)
            errors.push(`AUTHORIZATION_TARGET_MISMATCH:${requirement.id}`);
        if (!sameStringSet(authorization.scope, requirement.scope)) {
            errors.push(`AUTHORIZATION_SCOPE_MISMATCH:${requirement.id}`);
        }
        const issuedAt = Date.parse(authorization.issuedAt);
        const expiresAt = Date.parse(authorization.expiresAt);
        const current = input.verificationTime.getTime();
        if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || issuedAt >= expiresAt) {
            errors.push(`AUTHORIZATION_TIME_RANGE_INVALID:${requirement.id}`);
        }
        else if (current < issuedAt)
            errors.push(`AUTHORIZATION_NOT_YET_VALID:${requirement.id}`);
        else if (current >= expiresAt)
            errors.push(`AUTHORIZATION_EXPIRED:${requirement.id}`);
        if (requirement.trustLevel === 'verified-attestation') {
            errors.push(`AUTHORIZATION_ATTESTATION_VERIFIER_UNAVAILABLE:${requirement.id}`);
        }
        else if (authorization.grantor.trustLevel !== 'local-claim') {
            errors.push(`AUTHORIZATION_TRUST_LEVEL_MISMATCH:${requirement.id}`);
        }
        else {
            trust.push({ requirementId: requirement.id, trustLevel: 'local-claim' });
        }
        const expectedReference = {
            kind: `authorization:${requirement.id}`,
            path: relative(input.projectRoot, path),
            sha256: reference.sha256,
        };
        const occurrences = input.ledgerEvents.flatMap((event) => event.artifactRefs)
            .filter((item) => JSON.stringify(item) === JSON.stringify(expectedReference)).length;
        if (requirement.consumeOnce && occurrences !== 1) {
            errors.push(`AUTHORIZATION_CONSUMPTION_INVALID:${requirement.id}:${occurrences}`);
        }
    }
    return {
        errors,
        trust: trust.sort((left, right) => left.requirementId.localeCompare(right.requirementId)),
    };
}
export function verifyHardenedCandidate(input, context = {}) {
    const schema = validateDocument('candidate', input);
    if (!schema.valid) {
        return {
            valid: false,
            errors: schema.errors.map((error) => `CANDIDATE_SCHEMA_INVALID:${error}`).sort(),
        };
    }
    const errors = [];
    if (context.candidatePath === undefined)
        return { valid: false, errors: ['CANDIDATE_PATH_REQUIRED'] };
    let candidatePath;
    let candidateRaw;
    try {
        const unresolvedCandidate = resolve(context.candidatePath);
        if (lstatSync(unresolvedCandidate).isSymbolicLink() || !lstatSync(unresolvedCandidate).isFile()) {
            return { valid: false, errors: ['CANDIDATE_ARTIFACT_UNSAFE'] };
        }
        candidatePath = realpathSync(unresolvedCandidate);
        candidateRaw = readFileSync(candidatePath);
        const candidateOnDisk = parse(candidateRaw.toString('utf8'));
        if (canonicalDigest(candidateOnDisk) !== canonicalDigest(input)) {
            errors.push('CANDIDATE_INPUT_FILE_MISMATCH');
        }
    }
    catch {
        return { valid: false, errors: ['CANDIDATE_FILE_UNREADABLE'] };
    }
    let contractArtifact;
    let evidenceArtifact;
    try {
        contractArtifact = readArtifact(input.contract, 'CONTRACT');
    }
    catch (error) {
        return { valid: false, errors: [error instanceof Error ? error.message : 'CONTRACT_ARTIFACT_UNREADABLE'] };
    }
    try {
        evidenceArtifact = readArtifact(input.evidence, 'EVIDENCE');
    }
    catch (error) {
        return { valid: false, errors: [error instanceof Error ? error.message : 'EVIDENCE_ARTIFACT_UNREADABLE'] };
    }
    const contract = contractArtifact.value;
    const contractValidation = validateHardenedTaskContract(contract);
    if (!contractValidation.valid) {
        return { valid: false, errors: contractValidation.errors.map((error) => `CONTRACT_INVALID:${error}`) };
    }
    const { contractDigest, ...unsignedContract } = contract;
    if (canonicalDigest(unsignedContract) !== contractDigest)
        errors.push('CONTRACT_DIGEST_INVALID');
    if (contract.taskId !== input.taskId)
        errors.push('CANDIDATE_TASK_ID_MISMATCH');
    const taskDirectory = dirname(contractArtifact.path);
    const projectRoot = realpathSync(resolve(taskDirectory, '../../..'));
    const expectedTaskDirectory = realpathSync(join(projectRoot, '.delivery', 'tasks', input.taskId));
    if (taskDirectory !== expectedTaskDirectory)
        errors.push('CONTRACT_TASK_DIRECTORY_MISMATCH');
    if (contractArtifact.path !== join(expectedTaskDirectory, 'contract.yaml')) {
        errors.push('CONTRACT_CANONICAL_PATH_MISMATCH');
    }
    if (candidatePath !== join(expectedTaskDirectory, 'candidate.yaml')) {
        errors.push('CANDIDATE_CANONICAL_PATH_MISMATCH');
    }
    if (evidenceArtifact.path !== join(expectedTaskDirectory, 'evidence.json')) {
        errors.push('EVIDENCE_CANONICAL_PATH_MISMATCH');
    }
    const ledger = readTaskLedger({
        projectRoot,
        taskId: input.taskId,
        contractDigest: contract.contractDigest,
        contractSha256: input.contract.sha256,
        implementationOwners: implementationOwnersOf(contract),
    });
    if (!ledger.valid) {
        errors.push(...ledger.errors.map((error) => `TASK_LEDGER_INVALID:${error}`));
    }
    else {
        if (context.requireCandidateState !== false && ledger.currentState !== 'CANDIDATE') {
            errors.push(`TASK_STATE_NOT_CANDIDATE:${ledger.currentState ?? 'UNKNOWN'}`);
        }
        const candidateEvent = [...ledger.events].reverse().find((event) => event.to === 'CANDIDATE');
        if (candidateEvent === undefined) {
            errors.push('TASK_CANDIDATE_EVENT_MISSING');
        }
        else {
            const expectedReferences = [
                { kind: 'candidate', path: relative(projectRoot, candidatePath), sha256: sha256(candidateRaw) },
                {
                    kind: 'evidence',
                    path: relative(projectRoot, evidenceArtifact.path),
                    sha256: input.evidence.sha256,
                },
            ].sort((left, right) => left.kind.localeCompare(right.kind));
            const actualReferences = [...candidateEvent.artifactRefs]
                .filter((reference) => reference.kind === 'candidate' || reference.kind === 'evidence')
                .sort((left, right) => left.kind.localeCompare(right.kind));
            if (JSON.stringify(actualReferences) !== JSON.stringify(expectedReferences)) {
                errors.push('TASK_CANDIDATE_EVENT_ARTIFACT_MISMATCH');
            }
        }
    }
    const identity = context.runnerIdentity ?? governanceIdentity();
    if (contract.policyDigest !== identity.digest || contract.sopVersion !== identity.version) {
        errors.push('CONTRACT_POLICY_IDENTITY_MISMATCH');
    }
    const evidence = evidenceArtifact.value;
    const evidenceSchema = validateDocument('evidence', evidence);
    if (!evidenceSchema.valid || evidence.schemaVersion !== 2) {
        errors.push(...evidenceSchema.errors.map((error) => `EVIDENCE_SCHEMA_INVALID:${error}`));
    }
    else {
        if (evidence.taskId !== contract.taskId)
            errors.push('EVIDENCE_TASK_ID_MISMATCH');
        if (evidence.contractDigest !== contract.contractDigest)
            errors.push('EVIDENCE_CONTRACT_MISMATCH');
        if (evidence.runner.version !== contract.sopVersion
            || evidence.runner.policyDigest !== contract.policyDigest)
            errors.push('EVIDENCE_RUNNER_IDENTITY_MISMATCH');
        if (!sameIdentities(evidence.implementationIdentities, input.implementationIdentities)) {
            errors.push('EVIDENCE_IMPLEMENTATION_IDENTITY_MISMATCH');
        }
    }
    const expectedRepositories = contract.repositories.map((repository) => repository.id).sort();
    const actualRepositories = input.implementationIdentities.map((item) => item.repositoryId).sort();
    if (new Set(actualRepositories).size !== actualRepositories.length) {
        errors.push('IMPLEMENTATION_REPOSITORY_IDS_DUPLICATED');
    }
    if (JSON.stringify(expectedRepositories) !== JSON.stringify(actualRepositories)) {
        errors.push('IMPLEMENTATION_REPOSITORY_SET_MISMATCH');
    }
    for (const repository of contract.repositories) {
        const candidateIdentity = input.implementationIdentities.find((identity_) => (identity_.repositoryId === repository.id));
        if (candidateIdentity?.repository !== repository.path) {
            errors.push(`IMPLEMENTATION_REPOSITORY_PATH_MISMATCH:${repository.id}`);
        }
    }
    const expectedAcceptance = contract.acceptance.map((acceptance) => acceptance.id);
    const actualAcceptance = evidence.receipts?.map((receipt) => receipt.acceptanceId) ?? [];
    if (new Set(actualAcceptance).size !== actualAcceptance.length) {
        errors.push('EVIDENCE_RECEIPT_IDS_DUPLICATED');
    }
    if (JSON.stringify(expectedAcceptance) !== JSON.stringify(actualAcceptance)) {
        errors.push('EVIDENCE_RECEIPT_ORDER_MISMATCH');
    }
    const verificationTime = context.evidenceVerificationTime ?? new Date();
    if (!Number.isFinite(verificationTime.getTime()))
        errors.push('VERIFICATION_TIME_INVALID');
    const verifiedReceipts = [];
    if (evidenceSchema.valid && evidence.schemaVersion === 2) {
        for (const receiptReference of evidence.receipts) {
            const gate = contract.acceptance.find((acceptance) => acceptance.id === receiptReference.acceptanceId);
            if (gate === undefined) {
                errors.push(`UNEXPECTED_ACCEPTANCE_ID:${receiptReference.acceptanceId}`);
                continue;
            }
            try {
                const path = containedArtifact(projectRoot, receiptReference.path);
                const receiptRelativePath = relative(join(expectedTaskDirectory, 'receipts'), path);
                if (receiptRelativePath.startsWith('..') || isAbsolute(receiptRelativePath)) {
                    errors.push(`RECEIPT_CANONICAL_PATH_MISMATCH:${receiptReference.acceptanceId}`);
                    continue;
                }
                const raw = readFileSync(path);
                if (sha256(raw) !== receiptReference.sha256) {
                    errors.push(`RECEIPT_ARTIFACT_DIGEST_MISMATCH:${receiptReference.acceptanceId}`);
                    continue;
                }
                const receipt = JSON.parse(raw.toString('utf8'));
                errors.push(...receiptErrors({
                    receipt,
                    gate,
                    contract,
                    contractArtifact: { path: contractArtifact.path, sha256: input.contract.sha256 },
                    evidence,
                    identities: input.implementationIdentities,
                    verificationTime,
                    maxEvidenceAgeMs: contract.evidenceFreshnessMs,
                    runnerIdentity: identity,
                }));
                verifiedReceipts.push({
                    acceptanceId: receiptReference.acceptanceId,
                    path,
                    sha256: receiptReference.sha256,
                });
            }
            catch (error) {
                errors.push(error instanceof Error
                    ? `${error.message}:${receiptReference.acceptanceId}`
                    : `RECEIPT_ARTIFACT_UNREADABLE:${receiptReference.acceptanceId}`);
            }
        }
    }
    const passedIds = verifiedReceipts
        .filter((receipt) => !errors.some((error) => error.includes(receipt.acceptanceId)))
        .map((receipt) => receipt.acceptanceId)
        .sort();
    if (JSON.stringify([...evidence.summary.passedIds].sort()) !== JSON.stringify(passedIds)
        || evidence.summary.failedIds.length > 0)
        errors.push('EVIDENCE_SUMMARY_MISMATCH');
    const gitIds = input.gitIdentities.map((gitIdentity) => gitIdentity.repositoryId).sort();
    if (JSON.stringify(gitIds) !== JSON.stringify(expectedRepositories)) {
        errors.push('GIT_IDENTITY_SET_MISMATCH');
    }
    for (const gitIdentity of input.gitIdentities) {
        const expected = input.implementationIdentities.find((identity_) => (identity_.repositoryId === gitIdentity.repositoryId));
        if (expected === undefined
            || expected.repository !== gitIdentity.repository
            || expected.commit !== gitIdentity.implementationCommit
            || expected.tree !== gitIdentity.implementationTree)
            errors.push(`GIT_IMPLEMENTATION_IDENTITY_MISMATCH:${gitIdentity.repositoryId}`);
        errors.push(...verifyGitIdentity(gitIdentity).errors.map((error) => (`GIT_IDENTITY_INVALID:${gitIdentity.repositoryId}:${error}`)));
    }
    const authorization = authorizationErrors({
        references: input.authorizationArtifacts,
        contract,
        projectRoot,
        taskDirectory: expectedTaskDirectory,
        ledgerEvents: ledger.events,
        verificationTime,
    });
    errors.push(...authorization.errors);
    if (isRemediationBridgeContract(contract)) {
        const bridge = remediationBridgeErrors({
            projectRoot,
            taskId: contract.taskId,
            actorId: primaryImplementationOwner(contract),
            role: 'implementation-owner',
            enforceExpiry: true,
            ledgerEvents: ledger.events,
            requireConsumption: true,
        });
        errors.push(...bridge.errors.map((error) => `REMEDIATION_BRIDGE_INVALID:${error}`));
    }
    const extensionResults = [];
    const implementationChanges = changedPaths(contract, input.implementationIdentities);
    errors.push(...implementationChanges.errors);
    const extensionKeys = contract.extensions.map((binding) => `${binding.id}@${binding.version}`);
    if (new Set(extensionKeys).size !== extensionKeys.length)
        errors.push('CONTRACT_EXTENSIONS_DUPLICATED');
    for (const binding of contract.extensions) {
        let descriptor;
        try {
            descriptor = extensionDescriptor(binding.id, binding.version);
        }
        catch {
            errors.push(`CONTRACT_EXTENSION_UNKNOWN:${binding.id}@${binding.version}`);
            continue;
        }
        if (descriptor.digest !== binding.digest) {
            errors.push(`CONTRACT_EXTENSION_DIGEST_MISMATCH:${binding.id}@${binding.version}`);
            continue;
        }
        const references = input.extensionArtifacts.filter((artifact) => artifact.extensionId === binding.id);
        if (binding.id === externalSourceExtensionId && binding.version === externalSourceExtensionVersion) {
            const extension = verifyExternalSourceArtifacts({
                binding,
                references,
                projectRoot,
                taskDirectory: expectedTaskDirectory,
                taskId: contract.taskId,
                contractDigest: contract.contractDigest,
                ledgerEvents: ledger.events,
                changedPaths: implementationChanges.paths,
            });
            errors.push(...extension.errors);
            if (extension.result !== undefined)
                extensionResults.push(extension.result);
        }
    }
    for (const reference of input.extensionArtifacts) {
        if (!contract.extensions.some((binding) => binding.id === reference.extensionId)) {
            errors.push(`EXTENSION_ARTIFACT_UNBOUND:${reference.extensionId}:${reference.kind}`);
        }
    }
    const replay = verifyCandidateReplay(candidatePath, verificationTime, contract.evidenceFreshnessMs, identity);
    errors.push(...replay.errors);
    const uniqueErrors = [...new Set(errors)].sort();
    if (uniqueErrors.length > 0)
        return { valid: false, errors: uniqueErrors };
    const verificationArtifact = {
        schemaVersion: 2,
        artifactType: 'sop-candidate-verification-v2',
        producer: {
            name: '@xgh/engineering-governance',
            version: identity.version,
            policyDigest: identity.digest,
        },
        taskId: input.taskId,
        contract: {
            path: contractArtifact.path,
            sha256: input.contract.sha256,
            digest: contract.contractDigest,
        },
        candidate: {
            path: candidatePath,
            sha256: sha256(candidateRaw),
            digest: canonicalDigest(input),
        },
        evidence: { path: evidenceArtifact.path, sha256: input.evidence.sha256 },
        receipts: verifiedReceipts,
        authorizationArtifacts: input.authorizationArtifacts
            .map((artifact) => ({ ...artifact, path: realpathSync(artifact.path) }))
            .sort((left, right) => left.requirementId.localeCompare(right.requirementId)),
        extensionArtifacts: input.extensionArtifacts
            .map((artifact) => ({ ...artifact, path: realpathSync(artifact.path) }))
            .sort((left, right) => (`${left.extensionId}:${left.kind}`.localeCompare(`${right.extensionId}:${right.kind}`))),
        implementationIdentities: canonicalIdentities(input.implementationIdentities),
        authorizationTrust: authorization.trust,
        extensionResults: extensionResults.sort((left, right) => left.extensionId.localeCompare(right.extensionId)),
        ...(replay.reference === undefined ? {} : { replay: replay.reference }),
        verifiedAt: verificationTime.toISOString(),
        decision: 'eligible',
    };
    const verificationSchema = validateDocument('verification', verificationArtifact);
    if (!verificationSchema.valid) {
        return {
            valid: false,
            errors: verificationSchema.errors.map((error) => `VERIFICATION_SCHEMA_INVALID:${error}`),
        };
    }
    return {
        valid: true,
        errors: [],
        verificationArtifact,
    };
}
export function persistHardenedVerificationArtifact(artifact) {
    const schema = validateDocument('verification', artifact);
    if (!schema.valid)
        throw new Error('VERIFICATION_ARTIFACT_SCHEMA_INVALID');
    const taskDirectory = dirname(realpathSync(artifact.candidate.path));
    const path = join(taskDirectory, 'verification.json');
    if (existsSync(path)) {
        if (lstatSync(path).isSymbolicLink())
            throw new Error('VERIFICATION_ARTIFACT_PATH_UNSAFE');
        throw new Error('VERIFICATION_ARTIFACT_ALREADY_EXISTS');
    }
    const content = `${JSON.stringify(artifact, null, 2)}\n`;
    writeFileSync(path, content, { flag: 'wx', mode: 0o644 });
    return { path, sha256: sha256(content) };
}
