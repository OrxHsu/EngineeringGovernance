import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { parse } from 'yaml';
import { governanceIdentity } from './adopt.js';
import { canonicalDigest } from '../model/digest.js';
import { implementationOwnersOf } from '../model/ownership.js';
import { normalizeActorId } from '../model/actor.js';
import { validateDocument } from '../policy/load.js';
import { validateHardenedTaskContract } from '../policy/task-contract.js';
import { planTaskTransition, readTaskLedger } from '../state/ledger.js';
import { verifyHardenedReview } from './task-review-v2.js';
import { actorEligibilityErrors, isAccountabilityContract } from '../accountability/enforce.js';
function sha256(input) {
    return createHash('sha256').update(input).digest('hex');
}
function readExact(reference, expectedPath, label) {
    const unresolved = resolve(reference.path);
    if (lstatSync(unresolved).isSymbolicLink() || !lstatSync(unresolved).isFile()) {
        throw new Error(`${label}_ARTIFACT_UNSAFE`);
    }
    const path = realpathSync(unresolved);
    if (path !== expectedPath)
        throw new Error(`${label}_CANONICAL_PATH_MISMATCH`);
    const raw = readFileSync(path);
    if (sha256(raw) !== reference.sha256)
        throw new Error(`${label}_ARTIFACT_DIGEST_MISMATCH`);
    return raw;
}
function statusArtifactErrors(root, reference) {
    try {
        const unresolved = resolve(reference.path);
        if (lstatSync(unresolved).isSymbolicLink() || !lstatSync(unresolved).isFile()) {
            return ['STATUS_ARTIFACT_UNSAFE'];
        }
        const path = realpathSync(unresolved);
        const relativePath = relative(root, path);
        if (relativePath.startsWith('..') || isAbsolute(relativePath))
            return ['STATUS_ARTIFACT_OUTSIDE_PROJECT'];
        return sha256(readFileSync(path)) === reference.sha256 ? [] : ['STATUS_ARTIFACT_DIGEST_MISMATCH'];
    }
    catch {
        return ['STATUS_ARTIFACT_UNREADABLE'];
    }
}
function boundArtifactErrors(root, reference, label) {
    try {
        const unresolved = resolve(reference.path);
        if (lstatSync(unresolved).isSymbolicLink() || !lstatSync(unresolved).isFile()) {
            return [`${label}_ARTIFACT_UNSAFE`];
        }
        const path = realpathSync(unresolved);
        const relativePath = relative(root, path);
        if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
            return [`${label}_ARTIFACT_OUTSIDE_PROJECT`];
        }
        return sha256(readFileSync(path)) === reference.sha256
            ? []
            : [`${label}_ARTIFACT_DIGEST_MISMATCH`];
    }
    catch {
        return [`${label}_ARTIFACT_UNREADABLE`];
    }
}
function canonicalBoundArtifacts(artifacts, key) {
    return [...artifacts].sort((left, right) => key(left).localeCompare(key(right)));
}
export function verifyHardenedClose(closurePathInput, now = new Date()) {
    let closurePath;
    let closure;
    try {
        const unresolved = resolve(closurePathInput);
        if (lstatSync(unresolved).isSymbolicLink() || !lstatSync(unresolved).isFile()) {
            return { valid: false, errors: ['CLOSURE_ARTIFACT_UNSAFE'] };
        }
        closurePath = realpathSync(unresolved);
        closure = parse(readFileSync(closurePath, 'utf8'));
    }
    catch {
        return { valid: false, errors: ['CLOSURE_FILE_UNREADABLE'] };
    }
    const schema = validateDocument('closure', closure);
    if (!schema.valid || closure.schemaVersion !== 2) {
        return {
            valid: false,
            errors: schema.errors.map((error) => `CLOSURE_SCHEMA_INVALID:${error}`),
        };
    }
    const taskDirectory = dirname(closurePath);
    const projectRoot = realpathSync(resolve(taskDirectory, '../../..'));
    const expectedTaskDirectory = realpathSync(join(projectRoot, '.delivery', 'tasks', closure.taskId));
    const errors = [];
    if (taskDirectory !== expectedTaskDirectory || closurePath !== join(taskDirectory, 'closure.yaml')) {
        errors.push('CLOSURE_CANONICAL_PATH_MISMATCH');
    }
    let contract;
    let candidate;
    let verification;
    let review;
    try {
        contract = parse(readExact(closure.contract, join(taskDirectory, 'contract.yaml'), 'CONTRACT').toString('utf8'));
        candidate = parse(readExact(closure.candidate, join(taskDirectory, 'candidate.yaml'), 'CANDIDATE').toString('utf8'));
        verification = JSON.parse(readExact(closure.verification, join(taskDirectory, 'verification.json'), 'VERIFICATION').toString('utf8'));
        review = parse(readExact(closure.review, join(taskDirectory, 'review.yaml'), 'REVIEW').toString('utf8'));
    }
    catch (error) {
        return { valid: false, errors: [error instanceof Error ? error.message : 'CLOSURE_BOUND_ARTIFACT_UNREADABLE'] };
    }
    const contractSchema = validateHardenedTaskContract(contract);
    if (!contractSchema.valid)
        errors.push(...contractSchema.errors.map((error) => `CONTRACT_INVALID:${error}`));
    else {
        const { contractDigest, ...unsigned } = contract;
        if (canonicalDigest(unsigned) !== contractDigest)
            errors.push('CONTRACT_DIGEST_INVALID');
        if (closure.contract.digest !== contractDigest)
            errors.push('CLOSURE_CONTRACT_DIGEST_MISMATCH');
        const identity = governanceIdentity();
        if (contract.sopVersion !== identity.version || contract.policyDigest !== identity.digest) {
            errors.push('CONTRACT_POLICY_IDENTITY_MISMATCH');
        }
    }
    if (!validateDocument('candidate', candidate).valid || candidate.schemaVersion !== 2) {
        errors.push('CANDIDATE_SCHEMA_INVALID');
    }
    if (canonicalDigest(candidate) !== closure.candidate.digest)
        errors.push('CLOSURE_CANDIDATE_DIGEST_MISMATCH');
    if (!validateDocument('verification', verification).valid || verification.schemaVersion !== 2) {
        errors.push('VERIFICATION_SCHEMA_INVALID');
    }
    if (!validateDocument('review', review).valid || review.schemaVersion !== 2)
        errors.push('REVIEW_SCHEMA_INVALID');
    if (review.decision !== 'ACCEPTED' || review.findings.length > 0)
        errors.push('REVIEW_NOT_ACCEPTED');
    if (closure.taskId !== contract.taskId || closure.taskId !== candidate.taskId
        || closure.taskId !== verification.taskId || closure.taskId !== review.taskId) {
        errors.push('CLOSURE_TASK_ID_MISMATCH');
    }
    if (JSON.stringify(review.contract) !== JSON.stringify(closure.contract)
        || JSON.stringify(verification.contract) !== JSON.stringify(closure.contract)) {
        errors.push('CLOSURE_CONTRACT_REF_MISMATCH');
    }
    if (JSON.stringify(review.candidate) !== JSON.stringify(closure.candidate)
        || JSON.stringify(verification.candidate) !== JSON.stringify(closure.candidate)) {
        errors.push('CLOSURE_CANDIDATE_REF_MISMATCH');
    }
    if (JSON.stringify(review.verification) !== JSON.stringify(closure.verification)) {
        errors.push('CLOSURE_VERIFICATION_REF_MISMATCH');
    }
    const recordedReview = verifyHardenedReview(closure.review.path, now, { mode: 'recorded' });
    if (!recordedReview.valid) {
        errors.push(...recordedReview.errors.map((error) => `REVIEW_REVALIDATION_FAILED:${error}`));
    }
    const expectedAuthorizations = canonicalBoundArtifacts(candidate.authorizationArtifacts, (artifact) => artifact.requirementId);
    const verifiedAuthorizations = canonicalBoundArtifacts(verification.authorizationArtifacts, (artifact) => artifact.requirementId);
    if (JSON.stringify(verifiedAuthorizations) !== JSON.stringify(expectedAuthorizations)) {
        errors.push('VERIFICATION_AUTHORIZATION_ARTIFACT_SET_MISMATCH');
    }
    for (const artifact of verifiedAuthorizations) {
        errors.push(...boundArtifactErrors(projectRoot, artifact, `VERIFIED_AUTHORIZATION:${artifact.requirementId}`));
    }
    const expectedExtensions = canonicalBoundArtifacts(candidate.extensionArtifacts, (artifact) => `${artifact.extensionId}:${artifact.kind}`);
    const verifiedExtensions = canonicalBoundArtifacts(verification.extensionArtifacts, (artifact) => `${artifact.extensionId}:${artifact.kind}`);
    if (JSON.stringify(verifiedExtensions) !== JSON.stringify(expectedExtensions)) {
        errors.push('VERIFICATION_EXTENSION_ARTIFACT_SET_MISMATCH');
    }
    for (const artifact of verifiedExtensions) {
        errors.push(...boundArtifactErrors(projectRoot, artifact, `VERIFIED_EXTENSION:${artifact.extensionId}:${artifact.kind}`));
    }
    const ledger = readTaskLedger({
        projectRoot,
        taskId: closure.taskId,
        contractDigest: contract.contractDigest,
        contractSha256: closure.contract.sha256,
        implementationOwners: implementationOwnersOf(contract),
    });
    if (!ledger.valid)
        errors.push(...ledger.errors.map((error) => `TASK_LEDGER_INVALID:${error}`));
    else if (ledger.currentState !== 'ACCEPTED') {
        errors.push(`TASK_STATE_NOT_ACCEPTED:${ledger.currentState ?? 'UNKNOWN'}`);
    }
    else {
        const accepted = ledger.events.at(-1);
        if (accepted.eventDigest !== closure.acceptedEventDigest)
            errors.push('CLOSURE_ACCEPTED_EVENT_MISMATCH');
        const expectedReviewRef = {
            kind: 'review',
            path: relative(projectRoot, closure.review.path),
            sha256: closure.review.sha256,
        };
        const expectedVerificationRef = {
            kind: 'verification',
            path: relative(projectRoot, closure.verification.path),
            sha256: closure.verification.sha256,
        };
        if (!accepted.artifactRefs.some((reference) => JSON.stringify(reference) === JSON.stringify(expectedReviewRef))) {
            errors.push('ACCEPTED_EVENT_REVIEW_REF_MISMATCH');
        }
        if (!accepted.artifactRefs.some((reference) => JSON.stringify(reference) === JSON.stringify(expectedVerificationRef))) {
            errors.push('ACCEPTED_EVENT_VERIFICATION_REF_MISMATCH');
        }
    }
    for (const status of closure.statusArtifacts)
        errors.push(...statusArtifactErrors(projectRoot, status));
    try {
        const combined = closure.statusArtifacts.map((artifact) => readFileSync(artifact.path, 'utf8')).join('\n');
        if (!combined.includes(closure.taskId))
            errors.push('STATUS_ARTIFACT_TASK_ID_MISSING');
        if (!combined.includes(closure.nextAction))
            errors.push('STATUS_ARTIFACT_NEXT_ACTION_MISSING');
    }
    catch {
        errors.push('STATUS_ARTIFACT_UNREADABLE');
    }
    let closerId;
    try {
        closerId = normalizeActorId(closure.closer.id);
    }
    catch {
        errors.push('CLOSER_ID_INVALID');
    }
    if (closerId !== undefined && isAccountabilityContract(contract, closure.taskId)) {
        errors.push(...actorEligibilityErrors({
            projectRoot,
            taskId: closure.taskId,
            actorId: closerId,
            role: 'closer',
            risk: contract.risk,
        }));
    }
    const uniqueErrors = [...new Set(errors)].sort();
    if (uniqueErrors.length > 0 || closerId === undefined) {
        return { valid: false, errors: uniqueErrors, closerTrust: 'local-claim' };
    }
    const transitionPlan = planTaskTransition({
        projectRoot,
        taskId: closure.taskId,
        actorId: closerId,
        to: 'CLOSED',
        artifacts: [
            { kind: 'closure', path: closurePath },
            ...closure.statusArtifacts.map((artifact) => ({ kind: 'status', path: artifact.path })),
        ],
    });
    return { valid: true, errors: [], closerTrust: 'local-claim', transitionPlan };
}
