import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { stringify } from 'yaml';
import { canonicalDigest } from '../model/digest.js';
import { normalizeActorId } from '../model/actor.js';
import { implementationOwnersOf } from '../model/ownership.js';
import { CURRENT_CONTRACT_READINESS_VERSION } from '../model/version.js';
import { classifyRisk, highestRisk } from '../policy/risk.js';
import { validateHardenedTaskContract } from '../policy/task-contract.js';
import { validateDocument } from '../policy/load.js';
import { initialTaskEvent } from '../state/ledger.js';
import { captureCheckoutSnapshot } from '../evidence/checkout-snapshot.js';
import { mutualReviewEnabled, mutualReviewErrors } from '../review/mutual-review.js';
import { externalSourceExtensionId, externalSourceExtensionVersion, externalSourceMinimumRisk, validateExternalSourceTaskInput, } from '../extensions/external-source.js';
import { governanceIdentity } from './adopt.js';
const taskIdPattern = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/u;
const riskSignalKeys = new Set([
    'readOnly',
    'localEdit',
    'mutation',
    'classificationComplete',
    'userVisible',
    'crossModule',
    'multiRepository',
    'persistentData',
    'authentication',
    'authorization',
    'privacy',
    'security',
    'migration',
    'destructive',
    'payments',
    'production',
    'deployment',
    'remoteMutation',
    'externalCommunication',
    'restrictedRuntime',
    'projectMinimum',
]);
const evidenceKinds = new Set([
    'static',
    'compile',
    'unit',
    'integration',
    'device',
    'cloud',
    'production',
]);
function record(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function exactKeys(value, required, optional = []) {
    const keys = Object.keys(value);
    const allowed = new Set([...required, ...optional]);
    return required.every((key) => Object.hasOwn(value, key))
        && keys.every((key) => allowed.has(key));
}
function nonEmptyString(value) {
    return typeof value === 'string' && value.length > 0;
}
function uniqueStringArray(value, minimum) {
    return Array.isArray(value)
        && value.length >= minimum
        && value.every((item) => nonEmptyString(item))
        && new Set(value).size === value.length;
}
function stringArray(value, minimum) {
    return Array.isArray(value)
        && value.length >= minimum
        && value.every((item) => nonEmptyString(item));
}
function validHash(value) {
    return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
}
function validRiskSignals(value) {
    if (!record(value) || Object.keys(value).length === 0)
        return false;
    for (const [key, signal] of Object.entries(value)) {
        if (!riskSignalKeys.has(key))
            return false;
        if (key === 'projectMinimum') {
            if (signal !== 'R0' && signal !== 'R1' && signal !== 'R2' && signal !== 'R3')
                return false;
        }
        else if (typeof signal !== 'boolean') {
            return false;
        }
    }
    return true;
}
function validCommand(value) {
    if (!record(value) || !exactKeys(value, ['repositoryId', 'cwd', 'executable', 'arguments'], ['environment'])) {
        return false;
    }
    if (!nonEmptyString(value.repositoryId)
        || !taskIdPattern.test(value.repositoryId)
        || !nonEmptyString(value.cwd)
        || !nonEmptyString(value.executable)) {
        return false;
    }
    if (!Array.isArray(value.arguments) || !value.arguments.every((argument) => typeof argument === 'string')) {
        return false;
    }
    if (Object.hasOwn(value, 'environment')) {
        if (!record(value.environment))
            return false;
        for (const [key, environmentValue] of Object.entries(value.environment)) {
            if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) || typeof environmentValue !== 'string' || environmentValue.includes('\0')) {
                return false;
            }
        }
    }
    return true;
}
function validObserverPolicy(value) {
    if (!record(value) || !nonEmptyString(value.output))
        return false;
    const baseKeys = ['expectedExitCode', 'output', 'checkoutMutation', 'replay'];
    const exactKeysForOutput = value.output === 'exact'
        ? [...baseKeys, 'expectedStdoutSha256', 'expectedStderrSha256']
        : baseKeys;
    if (!exactKeys(value, baseKeys, value.output === 'exact'
        ? ['expectedStdoutSha256', 'expectedStderrSha256']
        : []))
        return false;
    if (!Number.isInteger(value.expectedExitCode)
        || value.checkoutMutation !== 'forbidden'
        || (value.replay !== 'required' && value.replay !== 'not-required' && value.replay !== 'prohibited')) {
        return false;
    }
    if (value.output !== 'exact' && value.output !== 'nonempty' && value.output !== 'exit-only')
        return false;
    if (value.output === 'exact') {
        return exactKeys(value, exactKeysForOutput)
            && validHash(value.expectedStdoutSha256)
            && validHash(value.expectedStderrSha256);
    }
    return true;
}
function validAcceptance(value) {
    if (!record(value) || !exactKeys(value, [
        'id',
        'observation',
        'positiveCases',
        'negativeCases',
        'evidenceKind',
        'command',
        'observerPolicy',
    ], ['bindingRefs']))
        return false;
    return nonEmptyString(value.id)
        && nonEmptyString(value.observation)
        && stringArray(value.positiveCases, 1)
        && stringArray(value.negativeCases, 1)
        && typeof value.evidenceKind === 'string'
        && evidenceKinds.has(value.evidenceKind)
        && validCommand(value.command)
        && validObserverPolicy(value.observerPolicy)
        && (!Object.hasOwn(value, 'bindingRefs') || uniqueStringArray(value.bindingRefs, 1));
}
function validAuthorizationRequirement(value) {
    if (!record(value) || !exactKeys(value, [
        'id',
        'action',
        'target',
        'scope',
        'trustLevel',
        'consumeOnce',
    ]))
        return false;
    return nonEmptyString(value.id)
        && nonEmptyString(value.action)
        && nonEmptyString(value.target)
        && uniqueStringArray(value.scope, 1)
        && (value.trustLevel === 'recorded-claim' || value.trustLevel === 'verified-attestation')
        && typeof value.consumeOnce === 'boolean';
}
function validateHardenedTaskStartInput(input) {
    if (!record(input) || input.schemaVersion !== 2) {
        throw new Error('ACTIVE_COMMAND_REQUIRES_SCHEMA_VERSION_2');
    }
    const evidenceFreshnessMs = input.evidenceFreshnessMs;
    if (!exactKeys(input, [
        'schemaVersion',
        'taskId',
        'objective',
        'scope',
        'nonGoals',
        'authorityInputs',
        'repositories',
        'acceptance',
        'authorizationRequirements',
        'openChoices',
        'signals',
    ], ['implementationOwner', 'implementationOwners', 'evidenceFreshnessMs', 'extensionInputs', 'contractAuthor', 'designBindings', 'predecessors', 'selfReview', 'knownIssues'])
        || typeof input.taskId !== 'string'
        || !taskIdPattern.test(input.taskId)
        || !nonEmptyString(input.objective)
        || !uniqueStringArray(input.scope, 1)
        || !uniqueStringArray(input.nonGoals, 0)
        || !uniqueStringArray(input.authorityInputs, 1)
        || !Array.isArray(input.repositories)
        || input.repositories.length === 0
        || input.repositories.some((repository) => (!record(repository)
            || !exactKeys(repository, ['id', 'path'])
            || typeof repository.id !== 'string'
            || !taskIdPattern.test(repository.id)
            || !nonEmptyString(repository.path)))
        || !Array.isArray(input.acceptance)
        || input.acceptance.length === 0
        || input.acceptance.some((acceptance) => !validAcceptance(acceptance))
        || !Array.isArray(input.authorizationRequirements)
        || input.authorizationRequirements.some((requirement) => !validAuthorizationRequirement(requirement))
        || !uniqueStringArray(input.openChoices, 0)
        || !validRiskSignals(input.signals)
        || (Object.hasOwn(input, 'evidenceFreshnessMs')
            && (typeof evidenceFreshnessMs !== 'number'
                || !Number.isInteger(evidenceFreshnessMs)
                || evidenceFreshnessMs < 1
                || evidenceFreshnessMs > 86_400_000))
        || (Object.hasOwn(input, 'extensionInputs')
            && input.extensionInputs !== undefined
            && !record(input.extensionInputs))
        || (Object.hasOwn(input, 'contractAuthor') && !nonEmptyString(input.contractAuthor))
        || (Object.hasOwn(input, 'designBindings') && !record(input.designBindings))
        || (Object.hasOwn(input, 'predecessors') && !Array.isArray(input.predecessors))
        || (Object.hasOwn(input, 'selfReview') && (input.selfReview === undefined || typeof input.selfReview !== 'object' || input.selfReview === null || Array.isArray(input.selfReview)))
        || (Object.hasOwn(input, 'knownIssues') && !Array.isArray(input.knownIssues))) {
        throw new Error('TASK_START_INPUT_INVALID');
    }
    implementationOwnersOf(input);
    const beta1Fields = ['contractAuthor', 'designBindings', 'predecessors'];
    const beta1Count = beta1Fields.filter((key) => Object.hasOwn(input, key)).length;
    if (beta1Count !== 0 && beta1Count !== beta1Fields.length)
        throw new Error('TASK_START_BETA1_INPUT_INCOMPLETE');
    if (mutualReviewEnabled(input)) {
        const errors = mutualReviewErrors(input);
        if (errors.length > 0)
            throw new Error(errors.join(','));
    }
}
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
    validateHardenedTaskStartInput(input);
    const beta1Input = input.contractAuthor !== undefined || input.designBindings !== undefined || input.predecessors !== undefined;
    if (beta1Input) {
        const schema = validateDocument('task-start-input', input);
        if (!schema.valid)
            throw new Error(schema.errors.map((error) => `TASK_START_INPUT_SCHEMA_INVALID:${error}`).join(','));
        if (typeof input.contractAuthor !== 'string' || input.contractAuthor.length === 0 || input.designBindings === undefined || !Array.isArray(input.predecessors)) {
            throw new Error('TASK_START_BETA1_FIELDS_REQUIRED');
        }
    }
    if (beta1Input && context.contractPreflight === undefined)
        throw new Error('TASK_START_PREFLIGHT_REQUIRED');
    if (context.contractPreflight !== undefined) {
        if (!beta1Input || context.contractPreflight.taskId !== input.taskId)
            throw new Error('TASK_START_PREFLIGHT_TASK_MISMATCH');
        const { planDigest, ...unsignedPreflight } = context.contractPreflight;
        if (canonicalDigest(unsignedPreflight) !== planDigest)
            throw new Error('TASK_START_PREFLIGHT_DIGEST_INVALID');
    }
    let risk = classifyRisk(input.signals);
    if (risk === 'R0')
        return { risk, state: 'DEFINED', artifacts: [] };
    const identity = governanceIdentity();
    const implementationOwners = implementationOwnersOf(input);
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
        implementationOwners,
        ...(beta1Input ? {
            contractAuthor: normalizeActorId(input.contractAuthor),
            contractPreflight: context.contractPreflight,
            designBindings: input.designBindings,
            predecessors: input.predecessors,
            ...(input.selfReview === undefined ? {} : { selfReview: input.selfReview, knownIssues: input.knownIssues }),
        } : {}),
        objective: input.objective,
        scope: input.scope,
        nonGoals: input.nonGoals,
        authorityInputs: input.authorityInputs,
        repositories,
        acceptance,
        evidenceFreshnessMs,
        authorizationRequirements: input.authorizationRequirements,
        contractReadiness: {
            required: risk === 'R2' || risk === 'R3',
            reviewPath: contractPath.replace(/contract\.yaml$/u, 'contract-review.yaml'),
            gateVersion: CURRENT_CONTRACT_READINESS_VERSION,
        },
        extensions,
        openChoices: input.openChoices,
    };
    const contract = { ...unsigned, contractDigest: taskContractDigest(unsigned) };
    const semantic = validateHardenedTaskContract(contract);
    if (!semantic.valid)
        throw new Error(semantic.errors.join(','));
    const contractContent = stringify(contract);
    const event = initialTaskEvent({
        actorId: implementationOwners[0],
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
    const reviewReady = input.contractAuthor !== undefined
        && input.designBindings !== undefined
        && input.predecessors !== undefined
        && input.selfReview !== undefined
        && Array.isArray(input.knownIssues)
        && context.contractPreflight !== undefined;
    if (result.risk === 'R3' && !reviewReady)
        throw new Error('TASK_START_REVIEW_READY_CONTRACT_REQUIRED');
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
