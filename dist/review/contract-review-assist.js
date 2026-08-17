import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';
import { validateHardenedTaskContract } from '../policy/task-contract.js';
import { implementationOwnersOf } from '../model/ownership.js';
function record(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function sha256(value) {
    return createHash('sha256').update(value).digest('hex');
}
function formatItems(value) {
    return Array.isArray(value) ? value.map((item) => `- ${String(item)}`).join('\n') : '';
}
function reviewPrompt(contract) {
    const selfReview = record(contract.selfReview) ? contract.selfReview : undefined;
    const knownIssues = Array.isArray(contract.knownIssues) ? contract.knownIssues : [];
    const common = [
        'Act as the independent contract reviewer. Do not modify the contract or implementation.',
        'Review the exact bound contract.',
        `Task: ${String(contract.taskId)}`,
        `Risk: ${String(contract.risk)}`,
        `Objective: ${String(contract.objective)}`,
        `Scope:\n${formatItems(contract.scope)}`,
        `Non-goals:\n${formatItems(contract.nonGoals)}`,
        `Authority inputs:\n${formatItems(contract.authorityInputs)}`,
        'Complete all existing contract-review-v2 checklist and R3 fields with exact evidence references.',
    ];
    if (selfReview === undefined) {
        return [
            ...common,
            'ACCEPTED is allowed only when the exact contract is complete and no blocking finding remains. Otherwise return REPAIR_REQUIRED with mechanically testable findings.',
            'Do not invent new requirements or treat style preferences as contract violations.',
        ].join('\n\n');
    }
    const selfReviewText = selfReview.dimensions
        .map((dimension) => `- ${dimension.name}: ${dimension.status} - ${dimension.evidence}`)
        .join('\n');
    return [
        ...common,
        'The author self-review is advisory evidence, never acceptance authority.',
        `Author self-review:\n${selfReviewText}`,
        `Known issues:\n${knownIssues.length === 0 ? '- None' : knownIssues.map((issue) => `- ${JSON.stringify(issue)}`).join('\n')}`,
        'Also complete assistedReview.checklist for scope coverage, acceptance sufficiency, authority completeness, R3 dimensions, compatibility, and self-review alignment.',
        'In assistedReview.selfReviewComparison, include the six self-review dimensions in canonical order. Copy each selfStatus exactly, state reviewerStatus, and recompute agreementRate, codexMissed, and codexOvercautious.',
        'ACCEPTED is allowed only when the exact contract is complete and no FAIL or blocking finding remains. Otherwise return REPAIR_REQUIRED with mechanically testable findings.',
        'Do not invent new requirements or treat style preferences as contract violations.',
    ].join('\n\n');
}
export function buildContractReviewRequest(projectRootInput, taskId) {
    const projectRoot = realpathSync(resolve(projectRootInput));
    const contractPath = join(projectRoot, '.delivery', 'tasks', taskId, 'contract.yaml');
    const canonicalPath = realpathSync(contractPath);
    if (canonicalPath !== contractPath || lstatSync(canonicalPath).isSymbolicLink() || !lstatSync(canonicalPath).isFile()) {
        throw new Error('CONTRACT_REVIEW_REQUEST_CONTRACT_UNSAFE');
    }
    const raw = readFileSync(canonicalPath);
    const value = parse(raw.toString('utf8'));
    const validation = validateHardenedTaskContract(value);
    if (!validation.valid || !record(value)) {
        throw new Error(`CONTRACT_REVIEW_REQUEST_CONTRACT_INVALID:${validation.errors.join(',')}`);
    }
    if (value.risk === 'R3' && (!record(value.selfReview) || !Array.isArray(value.knownIssues))) {
        throw new Error('CONTRACT_REVIEW_REQUEST_SELF_REVIEW_REQUIRED');
    }
    const independentFrom = [value.contractAuthor, ...implementationOwnersOf(value)]
        .filter((actor) => typeof actor === 'string')
        .filter((actor, index, actors) => actors.indexOf(actor) === index)
        .sort();
    return {
        schemaVersion: 1,
        artifactType: 'engineering-governance-contract-review-request-v1',
        taskId,
        timeoutSeconds: 900,
        contract: { path: canonicalPath, rawSha256: sha256(raw), digest: String(value.contractDigest) },
        reviewerConstraints: { independentFrom, decisionAuthority: 'contract-review-v2-verifier' },
        prompt: reviewPrompt(value),
    };
}
