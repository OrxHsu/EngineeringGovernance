import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { deriveMetrics } from '../metrics/derive.js';
import { validateDocument } from '../policy/load.js';
import { checkProject } from './check.js';
import { artifactDigest, verifyLegacyReviewEligibility } from './task-review.js';
import { verifyHardenedClose } from './task-close-v2.js';
function artifactErrors(reference, label) {
    try {
        const raw = readFileSync(reference.path);
        const errors = [];
        if (raw.length === 0)
            errors.push(`${label}_EMPTY`);
        if (artifactDigest(reference.path) !== reference.sha256)
            errors.push(`${label}_DIGEST_MISMATCH`);
        return errors;
    }
    catch {
        return [`${label}_UNREADABLE`];
    }
}
function statusCoherenceErrors(closure) {
    try {
        const contents = closure.statusArtifacts.map((artifact) => readFileSync(artifact.path, 'utf8'));
        const combined = contents.join('\n');
        const errors = [];
        if (!combined.includes(closure.taskId))
            errors.push('STATUS_ARTIFACT_TASK_ID_MISSING');
        if (!combined.includes(closure.nextAction))
            errors.push('STATUS_ARTIFACT_NEXT_ACTION_MISSING');
        return errors;
    }
    catch {
        return [];
    }
}
export function verifyCloseEligibility(input) {
    let closure;
    try {
        closure = parse(readFileSync(input.closurePath, 'utf8'));
    }
    catch {
        return { valid: false, errors: ['CLOSURE_FILE_UNREADABLE'] };
    }
    if (closure.schemaVersion === 2) {
        return verifyHardenedClose(input.closurePath);
    }
    return { valid: false, errors: ['LEGACY_CLOSE_REQUIRES_PINNED_V1_RUNNER'] };
}
export function verifyLegacyCloseEligibility(input) {
    let closure;
    try {
        closure = parse(readFileSync(input.closurePath, 'utf8'));
    }
    catch {
        return { valid: false, errors: ['CLOSURE_FILE_UNREADABLE'] };
    }
    const schema = validateDocument('closure', closure);
    if (!schema.valid) {
        return {
            valid: false,
            errors: schema.errors.map((error) => `CLOSURE_SCHEMA_INVALID:${error}`),
        };
    }
    const errors = [
        ...artifactErrors(closure.candidate, 'CANDIDATE_ARTIFACT'),
        ...artifactErrors(closure.review, 'REVIEW_ARTIFACT'),
        ...closure.statusArtifacts.flatMap((artifact, index) => (artifactErrors(artifact, `STATUS_ARTIFACT_${index}`))),
    ];
    if (errors.length === 0)
        errors.push(...statusCoherenceErrors(closure));
    if (errors.length === 0) {
        errors.push(...verifyLegacyReviewEligibility({
            candidatePath: closure.candidate.path,
            reviewPath: closure.review.path,
            replayPlanDigest: closure.replayPlanDigest,
        }).errors.map((error) => `REVIEW_INVALID:${error}`));
    }
    try {
        const candidate = parse(readFileSync(closure.candidate.path, 'utf8'));
        if (candidate.verification?.contractPath === undefined) {
            errors.push('CANDIDATE_CONTRACT_PATH_MISSING');
        }
        else {
            const contract = parse(readFileSync(candidate.verification.contractPath, 'utf8'));
            if (contract.taskId !== closure.taskId)
                errors.push('CLOSURE_TASK_ID_MISMATCH');
            if (contract.contractDigest !== closure.contractDigest) {
                errors.push('CLOSURE_CONTRACT_DIGEST_MISMATCH');
            }
        }
    }
    catch {
        errors.push('CLOSURE_CONTRACT_UNREADABLE');
    }
    const projectStatus = checkProject(closure.projectPath);
    errors.push(...projectStatus.errors.map((error) => `PROJECT_STATUS_INCOHERENT:${error}`));
    const uniqueErrors = [...new Set(errors)].sort();
    return { valid: uniqueErrors.length === 0, errors: uniqueErrors };
}
export function closeTaskWithMetrics(input) {
    return {
        eligibility: verifyCloseEligibility(input.eligibility),
        metrics: deriveMetrics(input.history),
    };
}
