import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { parse } from 'yaml';
import { normalizeActorId } from '../model/actor.js';
import { implementationOwnersOf, isImplementationOwner, primaryImplementationOwner } from '../model/ownership.js';
import { canonicalDigest } from '../model/digest.js';
import { validateDocument } from '../policy/load.js';
import { validateHardenedTaskContract } from '../policy/task-contract.js';
import { deriveAccountabilityStatus } from './derive.js';
import { assertAccountabilityPolicy } from './policy.js';
function record(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function sha256(input) {
    return createHash('sha256').update(input).digest('hex');
}
function sameStringSet(left, right) {
    return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}
function safeTaskId(value) {
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(value))
        throw new Error('ACCOUNTABILITY_TASK_ID_INVALID');
}
function safeContainedFile(projectRoot, inputPath, label) {
    const root = realpathSync(resolve(projectRoot));
    const unresolved = isAbsolute(inputPath) ? resolve(inputPath) : resolve(root, inputPath);
    const relativePath = relative(root, unresolved);
    if (relativePath.startsWith('..') || isAbsolute(relativePath))
        throw new Error(`${label}_OUTSIDE_PROJECT`);
    if (!existsSync(unresolved) || lstatSync(unresolved).isSymbolicLink() || !lstatSync(unresolved).isFile()) {
        throw new Error(`${label}_UNSAFE`);
    }
    const path = realpathSync(unresolved);
    if (path !== unresolved)
        throw new Error(`${label}_NONCANONICAL`);
    return path;
}
function taskFile(projectRoot, taskId, ...segments) {
    safeTaskId(taskId);
    const root = realpathSync(resolve(projectRoot));
    const taskRoot = join(root, '.delivery', 'tasks', taskId);
    if (!existsSync(taskRoot) || lstatSync(taskRoot).isSymbolicLink() || !lstatSync(taskRoot).isDirectory() || realpathSync(taskRoot) !== taskRoot) {
        throw new Error('ACCOUNTABILITY_TASK_DIRECTORY_UNSAFE');
    }
    return safeContainedFile(root, join(taskRoot, ...segments), 'ACCOUNTABILITY_TASK_ARTIFACT');
}
function loadContract(projectRoot, taskId) {
    const path = taskFile(projectRoot, taskId, 'contract.yaml');
    const raw = readFileSync(path);
    const contract = parse(raw.toString('utf8'));
    const validation = validateHardenedTaskContract(contract);
    if (!validation.valid)
        throw new Error(`ACCOUNTABILITY_CONTRACT_INVALID:${validation.errors.join(',')}`);
    if (contract.taskId !== taskId)
        throw new Error('ACCOUNTABILITY_CONTRACT_TASK_MISMATCH');
    const { contractDigest, ...unsigned } = contract;
    if (canonicalDigest(unsigned) !== contractDigest)
        throw new Error('ACCOUNTABILITY_CONTRACT_DIGEST_INVALID');
    return { contract, path, raw };
}
function requirements(contract) {
    if (!record(contract) || !Array.isArray(contract.authorizationRequirements))
        return [];
    return contract.authorizationRequirements.filter((value) => (record(value)
        && typeof value.id === 'string'
        && typeof value.action === 'string'
        && typeof value.target === 'string'
        && Array.isArray(value.scope)
        && value.scope.every((item) => typeof item === 'string')
        && (value.trustLevel === 'recorded-claim' || value.trustLevel === 'verified-attestation')
        && typeof value.consumeOnce === 'boolean'));
}
function authorityInputs(contract) {
    if (!record(contract) || !Array.isArray(contract.authorityInputs))
        return [];
    return contract.authorityInputs.filter((value) => typeof value === 'string');
}
export function isRemediationBridgeContract(contract) {
    const defectInputs = authorityInputs(contract).filter((value) => value.endsWith('/contract-defect.yaml'));
    const values = requirements(contract);
    return defectInputs.length === 1 && values.length === 1 && values[0].consumeOnce;
}
function isHistoricalRemediationContract(contract) {
    return requirements(contract).some((requirement) => (requirement.consumeOnce
        && requirement.scope.some((entry) => entry.includes('engineering-governance-remediation-authorization-v1'))));
}
export function isAccountabilityContract(contract, _taskId) {
    if (!record(contract))
        return false;
    if (contract.contractAuthor !== undefined || contract.contractPreflight !== undefined || contract.designBindings !== undefined || contract.predecessors !== undefined)
        return true;
    return isRemediationBridgeContract(contract) || isHistoricalRemediationContract(contract);
}
function authorizationWindow(scope) {
    const matches = scope.flatMap((entry) => {
        const match = /Use issuedAt ([0-9-]+T[^ ]+Z) and expiresAt ([0-9-]+T[^ ;]+Z)/u.exec(entry);
        return match === null ? [] : [{ issuedAt: match[1], expiresAt: match[2] }];
    });
    return matches.length === 1 ? matches[0] : undefined;
}
function validateTimeWindow(issuedAt, expiresAt, expected, enforceExpiry) {
    const errors = [];
    const issued = Date.parse(issuedAt);
    const expires = Date.parse(expiresAt);
    if (!Number.isFinite(issued) || !Number.isFinite(expires) || issued >= expires)
        errors.push('ACCOUNTABILITY_AUTHORIZATION_TIME_RANGE_INVALID');
    if (expected === undefined || issuedAt !== expected.issuedAt || expiresAt !== expected.expiresAt) {
        errors.push('ACCOUNTABILITY_AUTHORIZATION_TIME_BINDING_INVALID');
    }
    if (enforceExpiry && Number.isFinite(expires) && Date.now() >= expires)
        errors.push('ACCOUNTABILITY_AUTHORIZATION_EXPIRED');
    if (enforceExpiry && Number.isFinite(issued) && Date.now() < issued)
        errors.push('ACCOUNTABILITY_AUTHORIZATION_NOT_YET_VALID');
    return errors;
}
function readLedger(path) {
    const errors = [];
    const events = [];
    const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
    for (const [index, line] of lines.entries()) {
        let event;
        try {
            event = JSON.parse(line);
        }
        catch {
            errors.push(`ACCOUNTABILITY_PREDECESSOR_LEDGER_JSON_INVALID:${index + 1}`);
            continue;
        }
        const schema = validateDocument('task-event', event);
        if (!schema.valid) {
            errors.push(...schema.errors.map((error) => `ACCOUNTABILITY_PREDECESSOR_LEDGER_SCHEMA_INVALID:${index + 1}:${error}`));
            continue;
        }
        const { eventDigest, ...unsigned } = event;
        if (canonicalDigest(unsigned) !== eventDigest)
            errors.push(`ACCOUNTABILITY_PREDECESSOR_LEDGER_DIGEST_INVALID:${index + 1}`);
        if (event.sequence !== index + 1)
            errors.push(`ACCOUNTABILITY_PREDECESSOR_LEDGER_SEQUENCE_INVALID:${index + 1}`);
        const previous = events.at(-1);
        if (index === 0) {
            if (event.previousEventDigest !== null || event.from !== null || event.to !== 'DEFINED')
                errors.push('ACCOUNTABILITY_PREDECESSOR_LEDGER_INITIAL_INVALID');
        }
        else if (previous === undefined || event.previousEventDigest !== previous.eventDigest || event.from !== previous.to) {
            errors.push(`ACCOUNTABILITY_PREDECESSOR_LEDGER_CHAIN_INVALID:${index + 1}`);
        }
        events.push(event);
    }
    return { events, errors };
}
function acceptedReviewErrors(input) {
    const errors = [];
    let review;
    try {
        const path = taskFile(input.projectRoot, input.taskId, 'contract-review.yaml');
        review = parse(readFileSync(path, 'utf8'));
    }
    catch {
        return ['ACCOUNTABILITY_CONTRACT_REVIEW_UNREADABLE'];
    }
    const schema = validateDocument('contract-review', review);
    if (!schema.valid)
        errors.push(...schema.errors.map((error) => `ACCOUNTABILITY_CONTRACT_REVIEW_SCHEMA_INVALID:${error}`));
    const contractRef = record(review.contract) ? review.contract : {};
    const reviewer = record(review.reviewer) ? review.reviewer : {};
    if (review.taskId !== input.taskId
        || review.decision !== 'ACCEPTED'
        || reviewer.id !== input.reviewerId
        || contractRef.path !== input.contractPath
        || contractRef.rawSha256 !== sha256(input.contractRaw)
        || contractRef.digest !== input.contract.contractDigest)
        errors.push('ACCOUNTABILITY_CONTRACT_REVIEW_BINDING_INVALID');
    return errors;
}
function authoritySemanticDigest(path, raw) {
    if (path.endsWith('.jsonl')) {
        try {
            return canonicalDigest(raw.toString('utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)));
        }
        catch {
            throw new Error('ACCOUNTABILITY_PREDECESSOR_BOOTSTRAP_SOURCE_INVALID');
        }
    }
    try {
        return canonicalDigest(parse(raw.toString('utf8')));
    }
    catch {
        throw new Error('ACCOUNTABILITY_PREDECESSOR_BOOTSTRAP_SOURCE_INVALID');
    }
}
function predecessorBootstrapBinding(projectRoot, contract) {
    const root = realpathSync(resolve(projectRoot));
    const bootstrapPath = taskFile(root, contract.taskId, 'accountability-bootstrap.yaml');
    const bootstrap = parse(readFileSync(bootstrapPath, 'utf8'));
    if (!record(bootstrap) || !validateDocument('accountability-bootstrap', bootstrap).valid || bootstrap.taskId !== contract.taskId || !Array.isArray(bootstrap.sources)) {
        throw new Error('ACCOUNTABILITY_PREDECESSOR_BOOTSTRAP_BINDING_INVALID');
    }
    const sources = bootstrap.sources.filter((source) => record(source));
    const defectSources = sources.filter((source) => source.kind === 'defect');
    if (defectSources.length !== 1 || typeof defectSources[0].path !== 'string') {
        throw new Error('ACCOUNTABILITY_PREDECESSOR_BOOTSTRAP_BINDING_INVALID');
    }
    const match = /^\.delivery\/tasks\/([a-z0-9][a-z0-9._-]*)\/contract-defect\.yaml$/u.exec(defectSources[0].path);
    if (match === null)
        throw new Error('ACCOUNTABILITY_PREDECESSOR_BOOTSTRAP_BINDING_INVALID');
    const predecessorTaskId = match[1];
    const expectedBase = `.delivery/tasks/${predecessorTaskId}`;
    const expected = new Map([
        [`${expectedBase}/contract.yaml`, 'contract'],
        [`${expectedBase}/contract-review.yaml`, 'review'],
        [`${expectedBase}/contract-defect.yaml`, 'defect'],
        [`${expectedBase}/ledger.jsonl`, 'ledger'],
    ]);
    const predecessorSources = sources.filter((source) => typeof source.path === 'string' && source.path.startsWith(`${expectedBase}/`));
    if (predecessorSources.length !== expected.size)
        throw new Error('ACCOUNTABILITY_PREDECESSOR_BOOTSTRAP_BINDING_INVALID');
    for (const [path, kind] of expected) {
        const matches = predecessorSources.filter((source) => source.path === path && source.kind === kind);
        if (matches.length !== 1 || typeof matches[0].rawSha256 !== 'string' || typeof matches[0].semanticDigest !== 'string') {
            throw new Error('ACCOUNTABILITY_PREDECESSOR_BOOTSTRAP_BINDING_INVALID');
        }
        const actualPath = safeContainedFile(root, path, 'ACCOUNTABILITY_PREDECESSOR_BOOTSTRAP_SOURCE');
        const raw = readFileSync(actualPath);
        if (sha256(raw) !== matches[0].rawSha256 || authoritySemanticDigest(actualPath, raw) !== matches[0].semanticDigest) {
            throw new Error('ACCOUNTABILITY_PREDECESSOR_BOOTSTRAP_BINDING_INVALID');
        }
    }
    const declared = new Set(authorityInputs(contract));
    if ([...expected.keys()].some((path) => !declared.has(path)))
        throw new Error('ACCOUNTABILITY_PREDECESSOR_BOOTSTRAP_BINDING_INVALID');
    const defectInputs = authorityInputs(contract).filter((value) => value.endsWith('/contract-defect.yaml'));
    if (defectInputs.length !== 1 || defectInputs[0] !== `${expectedBase}/contract-defect.yaml`) {
        throw new Error('ACCOUNTABILITY_PREDECESSOR_BOOTSTRAP_BINDING_INVALID');
    }
    return { defectPath: `${expectedBase}/contract-defect.yaml`, predecessorTaskId, expectedBase };
}
function predecessorDefectErrors(projectRoot, contract) {
    const errors = [];
    const root = realpathSync(resolve(projectRoot));
    let binding;
    try {
        binding = predecessorBootstrapBinding(root, contract);
    }
    catch {
        return ['ACCOUNTABILITY_PREDECESSOR_BOOTSTRAP_BINDING_INVALID'];
    }
    let defectPath;
    let defectRaw;
    let defect;
    try {
        defectPath = safeContainedFile(root, binding.defectPath, 'ACCOUNTABILITY_PREDECESSOR_DEFECT');
        defectRaw = readFileSync(defectPath);
        defect = parse(defectRaw.toString('utf8'));
    }
    catch {
        return ['ACCOUNTABILITY_PREDECESSOR_DEFECT_UNREADABLE'];
    }
    const replacement = record(defect.requiredReplacement) ? defect.requiredReplacement : {};
    if (defect.artifactType !== 'engineering-governance-contract-defect-v1'
        || defect.severity !== 'BLOCKER'
        || defect.classification !== 'newly_discovered_contract_defect'
        || replacement.taskId !== contract.taskId
        || typeof defect.taskId !== 'string')
        errors.push('ACCOUNTABILITY_PREDECESSOR_DEFECT_BINDING_INVALID');
    if (typeof defect.taskId !== 'string')
        return errors;
    const predecessorTaskId = defect.taskId;
    const expectedBase = `.delivery/tasks/${predecessorTaskId}`;
    if (predecessorTaskId !== binding.predecessorTaskId || expectedBase !== binding.expectedBase) {
        return [...errors, 'ACCOUNTABILITY_PREDECESSOR_BOOTSTRAP_BINDING_INVALID'];
    }
    const requiredAuthorities = [
        `${expectedBase}/contract.yaml`,
        `${expectedBase}/contract-review.yaml`,
        `${expectedBase}/contract-defect.yaml`,
        `${expectedBase}/ledger.jsonl`,
    ];
    const declared = new Set(authorityInputs(contract));
    for (const authority of requiredAuthorities) {
        if (!declared.has(authority))
            errors.push(`ACCOUNTABILITY_PREDECESSOR_AUTHORITY_MISSING:${authority}`);
    }
    let predecessorContractPath;
    let predecessorContractRaw;
    let predecessorContract;
    let predecessorReviewRaw;
    try {
        predecessorContractPath = safeContainedFile(root, `${expectedBase}/contract.yaml`, 'ACCOUNTABILITY_PREDECESSOR_CONTRACT');
        predecessorContractRaw = readFileSync(predecessorContractPath);
        predecessorContract = parse(predecessorContractRaw.toString('utf8'));
        const predecessorReviewPath = safeContainedFile(root, `${expectedBase}/contract-review.yaml`, 'ACCOUNTABILITY_PREDECESSOR_REVIEW');
        predecessorReviewRaw = readFileSync(predecessorReviewPath);
    }
    catch {
        return [...errors, 'ACCOUNTABILITY_PREDECESSOR_AUTHORITY_UNREADABLE'];
    }
    const defectAuthorities = record(defect.authorities) ? defect.authorities : {};
    const defectContract = record(defectAuthorities.contract) ? defectAuthorities.contract : {};
    const defectReview = record(defectAuthorities.acceptedContractReview) ? defectAuthorities.acceptedContractReview : {};
    if (predecessorContract.taskId !== predecessorTaskId
        || defectContract.path !== relative(root, predecessorContractPath)
        || defectContract.rawSha256 !== sha256(predecessorContractRaw)
        || defectContract.semanticDigest !== predecessorContract.contractDigest
        || defectReview.rawSha256 !== sha256(predecessorReviewRaw))
        errors.push('ACCOUNTABILITY_PREDECESSOR_IDENTITY_INVALID');
    try {
        const ledgerPath = safeContainedFile(root, `${expectedBase}/ledger.jsonl`, 'ACCOUNTABILITY_PREDECESSOR_LEDGER');
        const ledger = readLedger(ledgerPath);
        errors.push(...ledger.errors);
        const last = ledger.events.at(-1);
        const expectedDefectReference = {
            kind: 'contract-defect',
            path: relative(root, defectPath),
            sha256: sha256(defectRaw),
        };
        if (last?.to !== 'SUPERSEDED'
            || !last.artifactRefs.some((reference) => JSON.stringify(reference) === JSON.stringify(expectedDefectReference)))
            errors.push('ACCOUNTABILITY_PREDECESSOR_DEFECT_NOT_LEDGER_BOUND');
    }
    catch {
        errors.push('ACCOUNTABILITY_PREDECESSOR_LEDGER_UNREADABLE');
    }
    return errors;
}
export function remediationBridgeErrors(input) {
    const errors = [];
    let loaded;
    try {
        loaded = loadContract(input.projectRoot, input.taskId);
    }
    catch (error) {
        return { applicable: false, valid: false, errors: [error instanceof Error ? error.message : 'ACCOUNTABILITY_CONTRACT_UNREADABLE'] };
    }
    if (!isRemediationBridgeContract(loaded.contract))
        return { applicable: false, valid: false, errors: [] };
    const root = realpathSync(resolve(input.projectRoot));
    const requirement = requirements(loaded.contract)[0];
    const expectedWindow = authorizationWindow(requirement.scope);
    const lifecyclePathExpected = join(root, '.delivery', 'tasks', input.taskId, 'authorizations', `${requirement.id}.json`);
    const sidecarPathExpected = join(root, '.delivery', 'tasks', input.taskId, 'remediation-authorization.json');
    let lifecycleRaw;
    let lifecycle;
    let sidecarRaw;
    let sidecar;
    try {
        const lifecyclePath = safeContainedFile(root, lifecyclePathExpected, 'ACCOUNTABILITY_LIFECYCLE_AUTHORIZATION');
        lifecycleRaw = readFileSync(lifecyclePath);
        lifecycle = JSON.parse(lifecycleRaw.toString('utf8'));
        const schema = validateDocument('authorization', lifecycle);
        if (!schema.valid || lifecycle.artifactType !== 'sop-authorization-v2') {
            errors.push(...schema.errors.map((error) => `ACCOUNTABILITY_LIFECYCLE_AUTHORIZATION_SCHEMA_INVALID:${error}`));
            if (lifecycle.artifactType !== 'sop-authorization-v2')
                errors.push('ACCOUNTABILITY_LIFECYCLE_AUTHORIZATION_TYPE_INVALID');
        }
    }
    catch {
        return { applicable: true, valid: false, errors: ['ACCOUNTABILITY_LIFECYCLE_AUTHORIZATION_UNREADABLE'], contract: loaded.contract };
    }
    try {
        const sidecarPath = safeContainedFile(root, sidecarPathExpected, 'ACCOUNTABILITY_REMEDIATION_SIDECAR');
        sidecarRaw = readFileSync(sidecarPath);
        sidecar = JSON.parse(sidecarRaw.toString('utf8'));
        const schema = validateDocument('authorization', sidecar);
        if (!schema.valid || sidecar.artifactType !== 'engineering-governance-remediation-authorization-v1' || !record(sidecar.lifecycleAuthorization)) {
            errors.push(...schema.errors.map((error) => `ACCOUNTABILITY_REMEDIATION_SIDECAR_SCHEMA_INVALID:${error}`));
            if (!record(sidecar.lifecycleAuthorization))
                errors.push('ACCOUNTABILITY_REMEDIATION_SIDECAR_LIFECYCLE_BINDING_MISSING');
        }
    }
    catch {
        return { applicable: true, valid: false, errors: ['ACCOUNTABILITY_REMEDIATION_SIDECAR_UNREADABLE'], contract: loaded.contract };
    }
    if (lifecycle.requirementId !== requirement.id
        || lifecycle.taskId !== loaded.contract.taskId
        || lifecycle.contractDigest !== loaded.contract.contractDigest
        || lifecycle.grantor.id !== 'user-authority'
        || lifecycle.grantor.role !== 'user'
        || lifecycle.grantor.trustLevel !== 'local-claim'
        || lifecycle.action !== requirement.action
        || requirement.target !== root
        || lifecycle.target !== requirement.target
        || !sameStringSet(lifecycle.scope, requirement.scope)
        || lifecycle.status !== 'approved')
        errors.push('ACCOUNTABILITY_LIFECYCLE_AUTHORIZATION_BINDING_INVALID');
    errors.push(...validateTimeWindow(lifecycle.issuedAt, lifecycle.expiresAt, expectedWindow, input.enforceExpiry !== false));
    const lifecycleSemanticDigest = canonicalDigest(lifecycle);
    if (sidecar.taskId !== loaded.contract.taskId
        || sidecar.requirementId !== requirement.id
        || sidecar.contract.path !== loaded.path
        || sidecar.contract.rawSha256 !== sha256(loaded.raw)
        || sidecar.contract.semanticDigest !== loaded.contract.contractDigest
        || sidecar.lifecycleAuthorization.path !== lifecyclePathExpected
        || sidecar.lifecycleAuthorization.rawSha256 !== sha256(lifecycleRaw)
        || sidecar.lifecycleAuthorization.semanticDigest !== lifecycleSemanticDigest
        || sidecar.lifecycleAuthorization.requirementId !== requirement.id
        || sidecar.grantor.id !== 'user-authority'
        || sidecar.grantor.role !== 'user'
        || sidecar.grantor.trustLevel !== 'local-claim'
        || sidecar.action !== requirement.action
        || sidecar.target !== requirement.target
        || !sameStringSet(sidecar.scope, requirement.scope)
        || sidecar.supervisorId !== 'user-authority'
        || sidecar.consumeOnce !== requirement.consumeOnce
        || sidecar.status !== 'approved'
        || sidecar.issuedAt !== lifecycle.issuedAt
        || sidecar.expiresAt !== lifecycle.expiresAt)
        errors.push('ACCOUNTABILITY_REMEDIATION_SIDECAR_BINDING_INVALID');
    errors.push(...validateTimeWindow(sidecar.issuedAt, sidecar.expiresAt, expectedWindow, input.enforceExpiry !== false));
    const actors = [
        ...implementationOwnersOf(loaded.contract),
        sidecar.supervisorId,
        sidecar.contractReviewerId,
        sidecar.implementationReviewerId,
    ].map(normalizeActorId);
    if (!isImplementationOwner(loaded.contract, input.actorId)
        || (input.role !== 'contract-author' && input.role !== 'implementation-owner')
        || new Set(actors).size !== actors.length)
        errors.push('ACCOUNTABILITY_REMEDIATION_ROLE_BINDING_INVALID');
    errors.push(...acceptedReviewErrors({
        projectRoot: root,
        taskId: input.taskId,
        contract: loaded.contract,
        contractPath: loaded.path,
        contractRaw: loaded.raw,
        reviewerId: sidecar.contractReviewerId,
    }));
    for (const actorId of [sidecar.supervisorId, sidecar.contractReviewerId, sidecar.implementationReviewerId]) {
        try {
            if (deriveAccountabilityStatus(root, actorId).standing !== 'GOOD_STANDING') {
                errors.push(`ACCOUNTABILITY_REMEDIATION_ACTOR_NOT_GOOD_STANDING:${actorId}`);
            }
        }
        catch (error) {
            errors.push(`ACCOUNTABILITY_REMEDIATION_ACTOR_UNAVAILABLE:${actorId}:${error instanceof Error ? error.message : 'UNKNOWN'}`);
        }
    }
    errors.push(...predecessorDefectErrors(root, loaded.contract));
    if (input.requireConsumption === true) {
        const events = input.ledgerEvents ?? [];
        const lifecycleReference = {
            kind: `authorization:${requirement.id}`,
            path: relative(root, lifecyclePathExpected),
            sha256: sha256(lifecycleRaw),
        };
        const sidecarReference = {
            kind: 'remediation-authorization',
            path: relative(root, sidecarPathExpected),
            sha256: sha256(sidecarRaw),
        };
        const allReferences = events.flatMap((event) => event.artifactRefs);
        const lifecycleOccurrences = allReferences.filter((reference) => JSON.stringify(reference) === JSON.stringify(lifecycleReference)).length;
        const sidecarOccurrences = allReferences.filter((reference) => JSON.stringify(reference) === JSON.stringify(sidecarReference)).length;
        const candidateEvents = events.filter((event) => (event.to === 'CANDIDATE'
            && event.artifactRefs.some((reference) => JSON.stringify(reference) === JSON.stringify(lifecycleReference))
            && event.artifactRefs.some((reference) => JSON.stringify(reference) === JSON.stringify(sidecarReference))));
        if (lifecycleOccurrences !== 1)
            errors.push(`ACCOUNTABILITY_LIFECYCLE_AUTHORIZATION_CONSUMPTION_INVALID:${lifecycleOccurrences}`);
        if (sidecarOccurrences !== 1)
            errors.push(`ACCOUNTABILITY_REMEDIATION_SIDECAR_CONSUMPTION_INVALID:${sidecarOccurrences}`);
        if (candidateEvents.length !== 1)
            errors.push(`ACCOUNTABILITY_REMEDIATION_CANDIDATE_BINDING_INVALID:${candidateEvents.length}`);
    }
    const uniqueErrors = [...new Set(errors)].sort();
    return {
        applicable: true,
        valid: uniqueErrors.length === 0,
        errors: uniqueErrors,
        contract: loaded.contract,
        lifecycleAuthorization: lifecycle,
        lifecycleAuthorizationPath: lifecyclePathExpected,
        lifecycleAuthorizationRawSha256: sha256(lifecycleRaw),
        lifecycleAuthorizationSemanticDigest: lifecycleSemanticDigest,
        sidecar,
        sidecarPath: sidecarPathExpected,
        sidecarRawSha256: sha256(sidecarRaw),
        sidecarSemanticDigest: canonicalDigest(sidecar),
    };
}
function historicalRemediationErrors(input) {
    let loaded;
    try {
        loaded = loadContract(input.projectRoot, input.taskId);
    }
    catch {
        return { applicable: false, errors: [] };
    }
    if (!isHistoricalRemediationContract(loaded.contract) || isRemediationBridgeContract(loaded.contract)) {
        return { applicable: false, errors: [] };
    }
    const values = requirements(loaded.contract);
    if (values.length !== 1)
        return { applicable: true, errors: ['ACCOUNTABILITY_HISTORICAL_AUTHORIZATION_REQUIREMENT_SET_INVALID'] };
    const requirement = values[0];
    let authorization;
    try {
        const path = taskFile(input.projectRoot, input.taskId, 'authorizations', `${requirement.id}.json`);
        authorization = JSON.parse(readFileSync(path, 'utf8'));
        const schema = validateDocument('authorization', authorization);
        if (!schema.valid || authorization.artifactType !== 'engineering-governance-remediation-authorization-v1' || 'lifecycleAuthorization' in authorization) {
            return { applicable: true, errors: ['ACCOUNTABILITY_HISTORICAL_AUTHORIZATION_SCHEMA_INVALID'] };
        }
    }
    catch {
        return { applicable: true, errors: ['ACCOUNTABILITY_HISTORICAL_AUTHORIZATION_UNREADABLE'] };
    }
    const errors = [];
    if (!isImplementationOwner(loaded.contract, input.actorId)
        || (input.role !== 'contract-author' && input.role !== 'implementation-owner')
        || authorization.taskId !== loaded.contract.taskId
        || authorization.requirementId !== requirement.id
        || authorization.contract.path !== loaded.path
        || authorization.contract.rawSha256 !== sha256(loaded.raw)
        || authorization.contract.semanticDigest !== loaded.contract.contractDigest
        || authorization.action !== requirement.action
        || requirement.target !== realpathSync(resolve(input.projectRoot))
        || authorization.target !== requirement.target
        || !sameStringSet(authorization.scope, requirement.scope)
        || authorization.grantor.id !== 'user-authority'
        || authorization.supervisorId !== 'user-authority'
        || authorization.consumeOnce !== requirement.consumeOnce
        || authorization.status !== 'approved')
        errors.push('ACCOUNTABILITY_HISTORICAL_AUTHORIZATION_BINDING_INVALID');
    errors.push(...validateTimeWindow(authorization.issuedAt, authorization.expiresAt, authorizationWindow(requirement.scope), input.enforceExpiry));
    return { applicable: true, errors: [...new Set(errors)].sort() };
}
export function readRemediationAuthorization(projectRoot, taskId) {
    assertAccountabilityPolicy(projectRoot);
    const verification = remediationBridgeErrors({
        projectRoot,
        taskId,
        actorId: primaryImplementationOwner(loadContract(projectRoot, taskId).contract),
        role: 'implementation-owner',
        enforceExpiry: true,
    });
    if (!verification.applicable || !verification.valid || verification.sidecar === undefined) {
        throw new Error(verification.errors[0] ?? 'ACCOUNTABILITY_REMEDIATION_AUTHORIZATION_INVALID');
    }
    return verification.sidecar;
}
export function authorizationDigest(projectRoot, taskId) {
    const verification = remediationBridgeErrors({
        projectRoot,
        taskId,
        actorId: primaryImplementationOwner(loadContract(projectRoot, taskId).contract),
        role: 'implementation-owner',
        enforceExpiry: true,
    });
    if (!verification.valid || verification.sidecarPath === undefined || verification.sidecarRawSha256 === undefined || verification.sidecarSemanticDigest === undefined) {
        throw new Error(verification.errors[0] ?? 'ACCOUNTABILITY_REMEDIATION_AUTHORIZATION_INVALID');
    }
    return {
        rawSha256: verification.sidecarRawSha256,
        semanticDigest: verification.sidecarSemanticDigest,
        path: verification.sidecarPath,
    };
}
export function assertStanding(projectRoot, actorId, minimum) {
    const status = deriveAccountabilityStatus(projectRoot, actorId);
    const rank = { GOOD_STANDING: 0, WARNING: 1, WATCH: 2, PROBATION: 3, SUSPENDED: 4 };
    if (rank[status.standing] > rank[minimum])
        throw new Error(`ACCOUNTABILITY_STANDING_INSUFFICIENT:${status.standing}:${minimum}`);
}
export function assertActorSeparation(...actorIds) {
    const normalized = actorIds.map(normalizeActorId);
    if (new Set(normalized).size !== normalized.length)
        throw new Error('ACCOUNTABILITY_ACTOR_SEPARATION_INVALID');
}
export function assertRemediationScope(input) {
    const verification = remediationBridgeErrors({
        projectRoot: input.projectRoot,
        taskId: input.taskId,
        actorId: input.actorId,
        role: 'implementation-owner',
        enforceExpiry: true,
    });
    if (!verification.valid || verification.sidecar === undefined || verification.contract === undefined) {
        throw new Error(verification.errors[0] ?? 'ACCOUNTABILITY_REMEDIATION_AUTHORIZATION_INVALID');
    }
    if (verification.sidecar.action !== input.action
        || verification.sidecar.contract.path !== resolve(input.contractPath)
        || verification.sidecar.contract.rawSha256 !== input.contractRawSha256
        || verification.sidecar.contract.semanticDigest !== input.contractSemanticDigest)
        throw new Error('ACCOUNTABILITY_AUTHORIZATION_SCOPE_MISMATCH');
    return verification.sidecar;
}
export function assertNoCallerStanding(value) {
    throw new Error(`ACCOUNTABILITY_CALLER_STANDING_IGNORED:${typeof value}`);
}
export function actorEligibilityErrors(input) {
    let standing;
    try {
        standing = deriveAccountabilityStatus(input.projectRoot, input.actorId).standing;
    }
    catch {
        return ['ACCOUNTABILITY_ACTOR_UNAVAILABLE'];
    }
    if (standing === 'GOOD_STANDING')
        return [];
    if (standing === 'WARNING') {
        if (input.risk === 'R3' || input.role === 'contract-reviewer' || input.role === 'implementation-reviewer')
            return ['ACCOUNTABILITY_WARNING_ROLE_FORBIDDEN'];
        if (input.risk === 'R2')
            return ['ACCOUNTABILITY_WARNING_SUPERVISION_REQUIRED'];
        return [];
    }
    if (standing === 'WATCH') {
        if (input.risk === 'R3' || input.role === 'contract-reviewer' || input.role === 'implementation-reviewer')
            return ['ACCOUNTABILITY_WATCH_ROLE_FORBIDDEN'];
        return ['ACCOUNTABILITY_WATCH_SUPERVISION_REQUIRED'];
    }
    if (input.role === 'contract-author' || input.role === 'implementation-owner') {
        const bridge = remediationBridgeErrors({
            projectRoot: input.projectRoot,
            taskId: input.taskId,
            actorId: input.actorId,
            role: input.role,
            enforceExpiry: input.enforceExpiry !== false,
        });
        if (bridge.applicable)
            return bridge.errors;
        const historical = historicalRemediationErrors({
            projectRoot: input.projectRoot,
            taskId: input.taskId,
            actorId: input.actorId,
            role: input.role,
            enforceExpiry: input.enforceExpiry !== false,
        });
        if (historical.applicable)
            return historical.errors;
    }
    return [standing === 'PROBATION' ? 'ACCOUNTABILITY_PROBATION_ROLE_FORBIDDEN' : 'ACCOUNTABILITY_SUSPENDED_ROLE_FORBIDDEN'];
}
