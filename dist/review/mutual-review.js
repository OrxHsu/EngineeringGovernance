import { canonicalDigest } from '../model/digest.js';
import { validateDocument } from '../policy/load.js';
export const SELF_REVIEW_DIMENSIONS = [
    'scope_coverage',
    'acceptance_sufficiency',
    'authority_completeness',
    'r3_mandatory',
    'contradictions',
    'obvious_gaps',
];
function record(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export function mutualReviewEnabled(input) {
    return Object.hasOwn(input, 'selfReview') || Object.hasOwn(input, 'knownIssues');
}
export function selfReviewSubject(input) {
    const subject = { ...input };
    delete subject.selfReview;
    delete subject.knownIssues;
    return subject;
}
export function selfReviewSubjectDigest(input) {
    return canonicalDigest(selfReviewSubject(input));
}
export function mutualReviewErrors(input) {
    if (!mutualReviewEnabled(input))
        return [];
    const errors = [];
    const selfReview = input.selfReview;
    const knownIssues = input.knownIssues;
    if (!record(selfReview))
        return ['PREFLIGHT_SELF_REVIEW_REQUIRED'];
    if (!Array.isArray(knownIssues))
        return ['PREFLIGHT_KNOWN_ISSUES_REQUIRED'];
    const selfReviewSchema = validateDocument('self-review', selfReview);
    errors.push(...selfReviewSchema.errors.map((error) => `PREFLIGHT_SELF_REVIEW_SCHEMA_INVALID:${error}`));
    const knownIssuesSchema = validateDocument('known-issues', knownIssues);
    errors.push(...knownIssuesSchema.errors.map((error) => `PREFLIGHT_KNOWN_ISSUES_SCHEMA_INVALID:${error}`));
    if (!selfReviewSchema.valid || !knownIssuesSchema.valid)
        return [...new Set(errors)].sort();
    const artifact = selfReview;
    const issues = knownIssues;
    const expectedNames = [...SELF_REVIEW_DIMENSIONS];
    const actualNames = artifact.dimensions.map((dimension) => dimension.name);
    if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
        errors.push('PREFLIGHT_SELF_REVIEW_DIMENSIONS_INVALID');
    }
    if (artifact.taskId !== input.taskId)
        errors.push('PREFLIGHT_SELF_REVIEW_TASK_MISMATCH');
    if (artifact.author !== input.contractAuthor)
        errors.push('PREFLIGHT_SELF_REVIEW_AUTHOR_MISMATCH');
    const expectedDigest = selfReviewSubjectDigest(input);
    if (artifact.subjectDigest !== expectedDigest
        || artifact.reviewId !== `srv-${String(input.taskId)}-${expectedDigest}`) {
        errors.push('PREFLIGHT_SELF_REVIEW_SUBJECT_MISMATCH');
    }
    if (Number.isNaN(Date.parse(artifact.reviewedAt)))
        errors.push('PREFLIGHT_SELF_REVIEW_TIMESTAMP_INVALID');
    const concernNames = new Set(artifact.dimensions
        .filter((dimension) => dimension.status === 'CONCERN')
        .map((dimension) => dimension.name));
    if (artifact.overallStatus === 'PASSED' && concernNames.size > 0) {
        errors.push('PREFLIGHT_SELF_REVIEW_STATUS_MISMATCH');
    }
    if (artifact.overallStatus === 'PASSED_WITH_CONCERNS' && concernNames.size === 0) {
        errors.push('PREFLIGHT_SELF_REVIEW_STATUS_MISMATCH');
    }
    if (artifact.overallStatus === 'TIMEOUT_SUBMITTED' && artifact.durationSeconds !== 300) {
        errors.push('PREFLIGHT_SELF_REVIEW_TIMEOUT_INVALID');
    }
    const issueKeys = issues.map((issue) => `${issue.dimension}:${issue.observation}`);
    if (new Set(issueKeys).size !== issueKeys.length)
        errors.push('PREFLIGHT_KNOWN_ISSUES_DUPLICATED');
    if (artifact.overallStatus !== 'TIMEOUT_SUBMITTED') {
        const issueDimensions = new Set(issues.map((issue) => issue.dimension));
        for (const name of concernNames) {
            if (!issueDimensions.has(name))
                errors.push(`PREFLIGHT_SELF_REVIEW_CONCERN_UNRECORDED:${name}`);
        }
        for (const issue of issues) {
            if (!concernNames.has(issue.dimension))
                errors.push(`PREFLIGHT_KNOWN_ISSUE_WITHOUT_CONCERN:${issue.dimension}`);
        }
    }
    return [...new Set(errors)].sort();
}
const questions = {
    scope_coverage: 'Does every objective goal have corresponding scope?',
    acceptance_sufficiency: 'Does every scope item have observable acceptance coverage?',
    authority_completeness: 'Are the governing inputs and changed modules identified?',
    r3_mandatory: 'For R3, are security, compatibility, and rollback covered?',
    contradictions: 'Do scope, non-goals, authorities, or transitions contradict each other?',
    obvious_gaps: 'Is any obvious positive, negative, provenance, or evidence case missing?',
};
function selfReviewPrompt(input) {
    const acceptance = Array.isArray(input.acceptance) ? input.acceptance : [];
    const acceptanceText = acceptance.map((item) => {
        if (!record(item))
            return '- invalid acceptance item';
        return `- ${String(item.id)}: ${String(item.observation ?? '')}`;
    }).join('\n');
    return [
        'Perform one quick contract-author self-review. This is advisory and cannot accept the contract.',
        'Use medium effort and stop after 300 seconds.',
        `Objective: ${String(input.objective ?? '')}`,
        `Scope:\n${Array.isArray(input.scope) ? input.scope.map((item) => `- ${String(item)}`).join('\n') : ''}`,
        `Non-goals:\n${Array.isArray(input.nonGoals) ? input.nonGoals.map((item) => `- ${String(item)}`).join('\n') : ''}`,
        `Acceptance:\n${acceptanceText}`,
        `Authority inputs:\n${Array.isArray(input.authorityInputs) ? input.authorityInputs.map((item) => `- ${String(item)}`).join('\n') : ''}`,
        'Return exactly six dimensions in the supplied order. Use PASS or CONCERN and evidence of at most 200 characters.',
        'Record every non-timeout concern once in knownIssues. Only LOW or MEDIUM may be deferred; repair blockers before submission.',
    ].join('\n\n');
}
export function createSelfReviewRequest(input, inputRawSha256) {
    if (mutualReviewEnabled(input))
        throw new Error('SELF_REVIEW_SINGLE_PASS_ONLY');
    if (typeof input.taskId !== 'string' || typeof input.contractAuthor !== 'string') {
        throw new Error('SELF_REVIEW_INPUT_INVALID');
    }
    const subjectDigest = selfReviewSubjectDigest(input);
    return {
        schemaVersion: 1,
        artifactType: 'engineering-governance-self-review-request-v1',
        taskId: input.taskId,
        author: input.contractAuthor,
        subjectDigest,
        inputRawSha256,
        effort: 'medium',
        timeoutSeconds: 300,
        dimensions: SELF_REVIEW_DIMENSIONS.map((name) => ({ name, question: questions[name] })),
        prompt: selfReviewPrompt(input),
    };
}
export function finalizeSelfReview(input, response, reviewedAt = new Date().toISOString()) {
    if (mutualReviewEnabled(input))
        throw new Error('SELF_REVIEW_SINGLE_PASS_ONLY');
    const subjectDigest = selfReviewSubjectDigest(input);
    const artifact = {
        schemaVersion: 1,
        artifactType: 'engineering-governance-self-review-v1',
        reviewId: `srv-${String(input.taskId)}-${subjectDigest}`,
        taskId: String(input.taskId),
        author: String(input.contractAuthor),
        subjectDigest,
        reviewedAt,
        durationSeconds: response.durationSeconds,
        attemptCount: 1,
        effort: 'medium',
        dimensions: response.dimensions,
        overallStatus: response.overallStatus,
    };
    const attached = { ...input, selfReview: artifact, knownIssues: response.knownIssues };
    const errors = mutualReviewErrors(attached);
    if (errors.length > 0)
        throw new Error(errors.join(','));
    return { selfReview: artifact, knownIssues: response.knownIssues };
}
