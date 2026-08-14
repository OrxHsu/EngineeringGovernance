import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parse } from 'yaml';
import { governanceIdentity } from './adopt.js';
import { verifyHardenedCandidate, } from './task-verify-v2.js';
import { canonicalDigest } from '../model/digest.js';
import { normalizeActorId } from '../model/actor.js';
import { validateDocument } from '../policy/load.js';
import { validateHardenedTaskContract } from '../policy/task-contract.js';
import { planTaskTransition, readTaskLedger } from '../state/ledger.js';
import { validateAcceptanceAuthority } from '../state/transitions.js';
function sha256(input) {
    return createHash('sha256').update(input).digest('hex');
}
function readExact(path, expectedPath, expectedSha256, label) {
    const unresolved = resolve(path);
    if (lstatSync(unresolved).isSymbolicLink() || !lstatSync(unresolved).isFile()) {
        throw new Error(`${label}_ARTIFACT_UNSAFE`);
    }
    const canonical = realpathSync(unresolved);
    if (canonical !== expectedPath)
        throw new Error(`${label}_CANONICAL_PATH_MISMATCH`);
    const raw = readFileSync(canonical);
    if (sha256(raw) !== expectedSha256)
        throw new Error(`${label}_ARTIFACT_DIGEST_MISMATCH`);
    return raw;
}
function sameIdentities(left, right) {
    const canonical = (items) => [...items]
        .sort((a, b) => a.repositoryId.localeCompare(b.repositoryId));
    return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}
function referenceErrors(reference, label) {
    try {
        const unresolved = resolve(reference.path);
        if (lstatSync(unresolved).isSymbolicLink() || !lstatSync(unresolved).isFile()) {
            return [`${label}_ARTIFACT_UNSAFE`];
        }
        return sha256(readFileSync(realpathSync(unresolved))) === reference.sha256
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
export function verifyHardenedReview(reviewPathInput, now = new Date(), context = {}) {
    const mode = context.mode ?? 'candidate';
    let reviewPath;
    let reviewRaw;
    let review;
    try {
        const unresolved = resolve(reviewPathInput);
        if (lstatSync(unresolved).isSymbolicLink() || !lstatSync(unresolved).isFile()) {
            return { valid: false, errors: ['REVIEW_ARTIFACT_UNSAFE'] };
        }
        reviewPath = realpathSync(unresolved);
        reviewRaw = readFileSync(reviewPath);
        review = parse(reviewRaw.toString('utf8'));
    }
    catch {
        return { valid: false, errors: ['REVIEW_FILE_UNREADABLE'] };
    }
    const schema = validateDocument('review', review);
    if (!schema.valid || review.schemaVersion !== 2) {
        return {
            valid: false,
            errors: schema.errors.map((error) => `REVIEW_SCHEMA_INVALID:${error}`),
        };
    }
    const taskDirectory = dirname(reviewPath);
    const projectRoot = realpathSync(resolve(taskDirectory, '../../..'));
    const expectedTaskDirectory = realpathSync(join(projectRoot, '.delivery', 'tasks', review.taskId));
    const errors = [];
    if (taskDirectory !== expectedTaskDirectory || reviewPath !== join(taskDirectory, 'review.yaml')) {
        errors.push('REVIEW_CANONICAL_PATH_MISMATCH');
    }
    let contract;
    let candidate;
    let verification;
    try {
        const raw = readExact(review.contract.path, join(taskDirectory, 'contract.yaml'), review.contract.sha256, 'CONTRACT');
        contract = parse(raw.toString('utf8'));
    }
    catch (error) {
        return { valid: false, errors: [error instanceof Error ? error.message : 'CONTRACT_ARTIFACT_UNREADABLE'] };
    }
    try {
        const raw = readExact(review.candidate.path, join(taskDirectory, 'candidate.yaml'), review.candidate.sha256, 'CANDIDATE');
        candidate = parse(raw.toString('utf8'));
    }
    catch (error) {
        return { valid: false, errors: [error instanceof Error ? error.message : 'CANDIDATE_ARTIFACT_UNREADABLE'] };
    }
    try {
        const raw = readExact(review.verification.path, join(taskDirectory, 'verification.json'), review.verification.sha256, 'VERIFICATION');
        verification = JSON.parse(raw.toString('utf8'));
    }
    catch (error) {
        return { valid: false, errors: [error instanceof Error ? error.message : 'VERIFICATION_ARTIFACT_UNREADABLE'] };
    }
    const contractSchema = validateHardenedTaskContract(contract);
    if (!contractSchema.valid)
        errors.push(...contractSchema.errors.map((error) => `CONTRACT_INVALID:${error}`));
    else {
        const { contractDigest, ...unsigned } = contract;
        if (canonicalDigest(unsigned) !== contractDigest)
            errors.push('CONTRACT_DIGEST_INVALID');
        if (review.contract.digest !== contractDigest)
            errors.push('REVIEW_CONTRACT_DIGEST_MISMATCH');
        const identity = governanceIdentity();
        if (contract.sopVersion !== identity.version || contract.policyDigest !== identity.digest) {
            errors.push('CONTRACT_POLICY_IDENTITY_MISMATCH');
        }
    }
    const candidateSchema = validateDocument('candidate', candidate);
    if (!candidateSchema.valid || candidate.schemaVersion !== 2)
        errors.push('CANDIDATE_SCHEMA_INVALID');
    if (canonicalDigest(candidate) !== review.candidate.digest)
        errors.push('REVIEW_CANDIDATE_DIGEST_MISMATCH');
    const verificationSchema = validateDocument('verification', verification);
    if (!verificationSchema.valid || verification.schemaVersion !== 2) {
        errors.push('VERIFICATION_SCHEMA_INVALID');
    }
    else {
        if (verification.taskId !== review.taskId)
            errors.push('VERIFICATION_TASK_ID_MISMATCH');
        if (JSON.stringify(verification.contract) !== JSON.stringify(review.contract)) {
            errors.push('VERIFICATION_CONTRACT_REF_MISMATCH');
        }
        if (JSON.stringify(verification.candidate) !== JSON.stringify(review.candidate)) {
            errors.push('VERIFICATION_CANDIDATE_REF_MISMATCH');
        }
        if (!sameIdentities(verification.implementationIdentities, review.reviewedImplementation)) {
            errors.push('REVIEW_IMPLEMENTATION_IDENTITY_MISMATCH');
        }
        errors.push(...referenceErrors(verification.evidence, 'VERIFIED_EVIDENCE'));
        for (const receipt of verification.receipts) {
            errors.push(...referenceErrors(receipt, `VERIFIED_RECEIPT:${receipt.acceptanceId}`));
        }
        const expectedAuthorizations = canonicalBoundArtifacts(candidate.authorizationArtifacts, (artifact) => artifact.requirementId);
        const verifiedAuthorizations = canonicalBoundArtifacts(verification.authorizationArtifacts, (artifact) => artifact.requirementId);
        if (JSON.stringify(verifiedAuthorizations) !== JSON.stringify(expectedAuthorizations)) {
            errors.push('VERIFICATION_AUTHORIZATION_ARTIFACT_SET_MISMATCH');
        }
        for (const artifact of verifiedAuthorizations) {
            errors.push(...referenceErrors(artifact, `VERIFIED_AUTHORIZATION:${artifact.requirementId}`));
        }
        const expectedExtensions = canonicalBoundArtifacts(candidate.extensionArtifacts, (artifact) => `${artifact.extensionId}:${artifact.kind}`);
        const verifiedExtensions = canonicalBoundArtifacts(verification.extensionArtifacts, (artifact) => `${artifact.extensionId}:${artifact.kind}`);
        if (JSON.stringify(verifiedExtensions) !== JSON.stringify(expectedExtensions)) {
            errors.push('VERIFICATION_EXTENSION_ARTIFACT_SET_MISMATCH');
        }
        for (const artifact of verifiedExtensions) {
            errors.push(...referenceErrors(artifact, `VERIFIED_EXTENSION:${artifact.extensionId}:${artifact.kind}`));
        }
        if (verification.replay !== undefined) {
            errors.push(...referenceErrors(verification.replay, 'VERIFIED_REPLAY'));
        }
        const verifiedAt = Date.parse(verification.verifiedAt);
        const age = now.getTime() - verifiedAt;
        if (!Number.isFinite(verifiedAt) || !Number.isFinite(now.getTime()))
            errors.push('VERIFICATION_TIME_INVALID');
        else if (age < 0)
            errors.push('VERIFICATION_TIME_IN_FUTURE');
        else if (age > contract.evidenceFreshnessMs)
            errors.push('VERIFICATION_STALE');
        const recomputed = verifyHardenedCandidate(candidate, {
            candidatePath: review.candidate.path,
            evidenceVerificationTime: new Date(verification.verifiedAt),
            requireCandidateState: mode === 'candidate',
        });
        if (!recomputed.valid || recomputed.verificationArtifact === undefined) {
            errors.push(...recomputed.errors.map((error) => `VERIFICATION_RECOMPUTATION_FAILED:${error}`));
        }
        else if (canonicalDigest(recomputed.verificationArtifact) !== canonicalDigest(verification)) {
            errors.push('VERIFICATION_RECOMPUTATION_MISMATCH');
        }
    }
    if (review.taskId !== contract.taskId || review.taskId !== candidate.taskId) {
        errors.push('REVIEW_TASK_ID_MISMATCH');
    }
    let reviewerId;
    try {
        reviewerId = normalizeActorId(review.reviewer.id);
    }
    catch {
        errors.push('REVIEWER_ID_INVALID');
    }
    if (reviewerId !== undefined) {
        errors.push(...validateAcceptanceAuthority(contract.risk, contract.implementationOwner, reviewerId).errors);
    }
    const findingIds = review.findings.map((finding) => finding.id);
    if (new Set(findingIds).size !== findingIds.length)
        errors.push('REVIEW_FINDING_IDS_DUPLICATED');
    const ledger = readTaskLedger({
        projectRoot,
        taskId: review.taskId,
        contractDigest: contract.contractDigest,
        contractSha256: review.contract.sha256,
        implementationOwner: contract.implementationOwner,
    });
    if (!ledger.valid)
        errors.push(...ledger.errors.map((error) => `TASK_LEDGER_INVALID:${error}`));
    else if (mode === 'candidate') {
        if (ledger.currentState !== 'CANDIDATE') {
            errors.push(`TASK_STATE_NOT_REVIEWABLE:${ledger.currentState ?? 'UNKNOWN'}`);
        }
    }
    else {
        const recordedEvent = [...ledger.events].reverse().find((event) => (event.to === review.decision
            && event.artifactRefs.some((reference) => (reference.kind === 'review'
                && reference.path === `.delivery/tasks/${review.taskId}/review.yaml`
                && reference.sha256 === sha256(reviewRaw)))
            && event.artifactRefs.some((reference) => (reference.kind === 'verification'
                && reference.path === `.delivery/tasks/${review.taskId}/verification.json`
                && reference.sha256 === review.verification.sha256))));
        if (recordedEvent === undefined)
            errors.push('REVIEW_LEDGER_EVENT_MISSING');
        else if (reviewerId !== undefined && recordedEvent.actorId !== reviewerId) {
            errors.push('REVIEW_LEDGER_ACTOR_MISMATCH');
        }
    }
    const uniqueErrors = [...new Set(errors)].sort();
    if (uniqueErrors.length > 0 || reviewerId === undefined) {
        return { valid: false, errors: uniqueErrors, reviewerTrust: 'local-claim' };
    }
    if (mode === 'recorded') {
        return { valid: true, errors: [], reviewerTrust: 'local-claim' };
    }
    const transitionPlan = planTaskTransition({
        projectRoot,
        taskId: review.taskId,
        actorId: reviewerId,
        to: review.decision,
        artifacts: [
            { kind: 'review', path: reviewPath },
            { kind: 'verification', path: review.verification.path },
        ],
    });
    return { valid: true, errors: [], reviewerTrust: 'local-claim', transitionPlan };
}
