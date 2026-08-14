import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { validateDocument } from '../policy/load.js';
import { validateAcceptanceAuthority } from '../state/transitions.js';
import { canonicalDigest } from '../model/digest.js';
import { isHardenedCandidate, verifyLegacyCandidateEligibility, } from './task-verify.js';
import { verifyHardenedReview } from './task-review-v2.js';
function digest(content) {
    return createHash('sha256').update(content).digest('hex');
}
function readStructured(path) {
    if (lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile()) {
        throw new Error('ARTIFACT_PATH_UNSAFE');
    }
    const raw = readFileSync(path);
    return { raw, value: parse(raw.toString('utf8')) };
}
function sameIdentities(left, right) {
    const canonical = (values) => ([...values].sort((a, b) => a.repository.localeCompare(b.repository)));
    return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}
export function verifyReviewEligibility(input) {
    let reviewSchemaVersion;
    try {
        const review = readStructured(input.reviewPath).value;
        reviewSchemaVersion = review.schemaVersion;
    }
    catch {
        return { valid: false, errors: ['REVIEW_FILE_UNREADABLE'] };
    }
    if (reviewSchemaVersion === 2)
        return verifyHardenedReview(input.reviewPath);
    return { valid: false, errors: ['LEGACY_REVIEW_REQUIRES_PINNED_V1_RUNNER'] };
}
export function verifyLegacyReviewEligibility(input) {
    const errors = [];
    let candidate;
    try {
        const loaded = readStructured(input.candidatePath);
        candidate = loaded.value;
    }
    catch {
        return { valid: false, errors: ['CANDIDATE_FILE_UNREADABLE'] };
    }
    const candidateSchema = validateDocument('candidate', candidate);
    if (!candidateSchema.valid) {
        return {
            valid: false,
            errors: candidateSchema.errors.map((error) => `CANDIDATE_SCHEMA_INVALID:${error}`),
        };
    }
    if (isHardenedCandidate(candidate)) {
        return { valid: false, errors: ['REVIEW_V2_VERIFICATION_ARTIFACT_REQUIRED'] };
    }
    const candidateDecision = verifyLegacyCandidateEligibility(candidate, {
        evidenceReplayPlanDigest: input.replayPlanDigest,
    });
    errors.push(...candidateDecision.errors.map((error) => `CANDIDATE_INVALID:${error}`));
    if (candidate.verification === undefined) {
        errors.push('CANDIDATE_VERIFICATION_REQUIRED');
        return { valid: false, errors: [...new Set(errors)].sort() };
    }
    let contract;
    try {
        contract = parse(readFileSync(candidate.verification.contractPath, 'utf8'));
    }
    catch {
        errors.push('CONTRACT_FILE_UNREADABLE');
        return { valid: false, errors: [...new Set(errors)].sort() };
    }
    let review;
    try {
        review = readStructured(input.reviewPath).value;
    }
    catch {
        errors.push('REVIEW_FILE_UNREADABLE');
        return { valid: false, errors: [...new Set(errors)].sort() };
    }
    const reviewSchema = validateDocument('review', review);
    if (!reviewSchema.valid) {
        errors.push(...reviewSchema.errors.map((error) => `REVIEW_SCHEMA_INVALID:${error}`));
        return { valid: false, errors: [...new Set(errors)].sort() };
    }
    if (review.taskId !== contract.taskId)
        errors.push('REVIEW_TASK_ID_MISMATCH');
    if (review.contractDigest !== contract.contractDigest)
        errors.push('REVIEW_CONTRACT_MISMATCH');
    if (review.candidateDigest !== canonicalDigest(candidate)) {
        errors.push('REVIEW_CANDIDATE_DIGEST_MISMATCH');
    }
    if (review.replayPlanDigest !== input.replayPlanDigest) {
        errors.push('REVIEW_REPLAY_PLAN_MISMATCH');
    }
    if (!sameIdentities(review.reviewedImplementation, candidate.verification.expectedImplementationIdentities)) {
        errors.push('REVIEW_IMPLEMENTATION_IDENTITY_MISMATCH');
    }
    errors.push(...validateAcceptanceAuthority(contract.risk, contract.implementationOwner, review.reviewer).errors);
    if (review.decision !== 'ACCEPTED')
        errors.push('REVIEW_REPAIR_REQUIRED');
    if (review.decision === 'ACCEPTED' && review.findings.length > 0) {
        errors.push('ACCEPTED_REVIEW_HAS_FINDINGS');
    }
    if (review.decision === 'REPAIR_REQUIRED' && review.findings.length === 0) {
        errors.push('REPAIR_REVIEW_FINDINGS_REQUIRED');
    }
    errors.push(...review.findings.map((finding) => `BLOCKING_FINDING:${finding.id}`));
    const uniqueErrors = [...new Set(errors)].sort();
    return { valid: uniqueErrors.length === 0, errors: uniqueErrors };
}
export function artifactDigest(path) {
    if (lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile()) {
        throw new Error('ARTIFACT_PATH_UNSAFE');
    }
    return digest(readFileSync(path));
}
