import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import { parse } from 'yaml';
import { normalizeActorId } from '../model/actor.js';
import { implementationOwnersOf } from '../model/ownership.js';
import { canonicalDigest } from '../model/digest.js';
import { validateDocument } from '../policy/load.js';
import { validateHardenedTaskContract } from '../policy/task-contract.js';
import { actorEligibilityErrors, isAccountabilityContract } from '../accountability/enforce.js';
import { accountabilityFindingErrors } from '../accountability/policy.js';
import { SELF_REVIEW_DIMENSIONS } from '../review/mutual-review.js';
import { canTransition } from './transitions.js';
import { historicalEvidenceKey, loadHistoricalEvidence, } from '../project/historical-evidence.js';
const checklistKeys = [
    'scope_non_goals',
    'authority_dependencies',
    'risk_owner_reviewer',
    'behavior_state_transitions',
    'security_trust',
    'evidence_environment',
    'external_source_provenance',
    'rollout_recovery_compatibility',
    'unresolved_product_decisions',
];
const r3Keys = [
    'trust_threat_analysis',
    'migration_recovery_rollback',
    'specialized_gates',
    'scoped_authorization',
    'production_observation',
];
// Contracts created by the pre-gate 2.0.0 runner are the only markerless
// histories that remain grandfathered after this gate is introduced.
export const PRE_GATE_POLICY_DIGEST = 'eba8165bd069c0e85e5b08217ea260e7b027e85158404a50644c03b57a909aca';
function sortedIds(items) {
    return items.every((item, index) => index === 0 || items[index - 1].id < item.id);
}
function sha256(input) {
    return createHash('sha256').update(input).digest('hex');
}
function findingsOrdered(items) {
    const severityRank = { BLOCKER: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
    return items.every((item, index) => {
        if (index === 0)
            return true;
        const previous = items[index - 1];
        const rank = severityRank[item.severity];
        const previousRank = severityRank[previous.severity];
        return rank > previousRank || (rank === previousRank && previous.id < item.id);
    });
}
function exactSorted(values, expected) {
    return JSON.stringify(values) === JSON.stringify([...expected].sort());
}
function assistedReviewErrors(projectRoot, selfReview, assistedReview, decision) {
    if (assistedReview === undefined)
        return ['CONTRACT_REVIEW_ASSISTED_REVIEW_REQUIRED'];
    const errors = [];
    for (const [key, item] of Object.entries(assistedReview.checklist)) {
        errors.push(...evidenceErrors(projectRoot, item.evidenceRefs, `ASSISTED_${key}`));
        if (decision === 'ACCEPTED' && item.status === 'FAIL') {
            errors.push(`CONTRACT_REVIEW_ASSISTED_FAILURE_UNRESOLVED:${key}`);
        }
    }
    const comparison = assistedReview.selfReviewComparison;
    const names = comparison.dimensions.map((dimension) => dimension.name);
    if (JSON.stringify(names) !== JSON.stringify(SELF_REVIEW_DIMENSIONS)) {
        errors.push('CONTRACT_REVIEW_COMPARISON_DIMENSIONS_INVALID');
        return errors;
    }
    const selfStatuses = new Map(selfReview.dimensions.map((dimension) => [dimension.name, dimension.status]));
    for (const dimension of comparison.dimensions) {
        if (selfStatuses.get(dimension.name) !== dimension.selfStatus) {
            errors.push(`CONTRACT_REVIEW_COMPARISON_SELF_STATUS_MISMATCH:${dimension.name}`);
        }
    }
    const agreementCount = comparison.dimensions.filter((dimension) => (dimension.selfStatus === 'PASS'
        ? dimension.reviewerStatus === 'PASS'
        : dimension.reviewerStatus !== 'PASS')).length;
    const agreementRate = Math.round((agreementCount / SELF_REVIEW_DIMENSIONS.length) * 10_000) / 100;
    if (comparison.agreementRate !== agreementRate)
        errors.push('CONTRACT_REVIEW_COMPARISON_RATE_INVALID');
    const missed = comparison.dimensions
        .filter((dimension) => dimension.selfStatus === 'PASS' && dimension.reviewerStatus !== 'PASS')
        .map((dimension) => dimension.name);
    const overcautious = comparison.dimensions
        .filter((dimension) => dimension.selfStatus === 'CONCERN' && dimension.reviewerStatus === 'PASS')
        .map((dimension) => dimension.name);
    if (!exactSorted(comparison.codexMissed, missed))
        errors.push('CONTRACT_REVIEW_COMPARISON_MISSED_INVALID');
    if (!exactSorted(comparison.codexOvercautious, overcautious))
        errors.push('CONTRACT_REVIEW_COMPARISON_OVERCAUTIOUS_INVALID');
    return errors;
}
function safeRegularFile(path) {
    try {
        if (!existsSync(path) || lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile())
            return undefined;
        return realpathSync(path);
    }
    catch {
        return undefined;
    }
}
function evidenceDigest(path) {
    const raw = readFileSync(path);
    if (['.yaml', '.yml', '.json'].includes(extname(path))) {
        try {
            return canonicalDigest(parse(raw.toString('utf8')));
        }
        catch { /* plain bytes below */ }
    }
    return canonicalDigest(raw.toString('utf8'));
}
function ledgerStructureValid(projectRoot, taskId, expectedContractDigest, raw) {
    if (raw.length === 0 || raw.at(-1) !== 0x0a)
        return false;
    const lines = raw.toString('utf8').split('\n').filter((line) => line.length > 0);
    if (lines.length === 0)
        return false;
    let contractDigest;
    let previous;
    try {
        for (const [index, line] of lines.entries()) {
            const event = JSON.parse(line);
            if (!validateDocument('task-event', event).valid)
                return false;
            const { eventDigest, ...unsigned } = event;
            if (canonicalDigest(unsigned) !== eventDigest || event.sequence !== index + 1)
                return false;
            contractDigest ??= event.contractDigest;
            if (event.contractDigest !== contractDigest || event.contractDigest !== expectedContractDigest)
                return false;
            if (index === 0) {
                const ref = event.artifactRefs.length === 1 ? event.artifactRefs[0] : undefined;
                if (event.previousEventDigest !== null || event.from !== null || event.to !== 'DEFINED'
                    || ref?.kind !== 'contract'
                    || ref.path !== `.delivery/tasks/${taskId}/contract.yaml`)
                    return false;
            }
            else if (previous !== undefined) {
                if (event.previousEventDigest !== previous.eventDigest
                    || event.from !== previous.to
                    || !canTransition(previous.to, event.to))
                    return false;
            }
            for (const ref of event.artifactRefs) {
                if (typeof ref.path !== 'string' || typeof ref.sha256 !== 'string')
                    return false;
                const unresolved = resolve(projectRoot, ref.path);
                if (relative(projectRoot, unresolved) !== ref.path)
                    return false;
                const canonical = safeRegularFile(unresolved);
                if (canonical === undefined || canonical !== unresolved || sha256(readFileSync(canonical)) !== ref.sha256)
                    return false;
            }
            previous = event;
        }
        return true;
    }
    catch {
        return false;
    }
}
function ledgerPrefixEvidenceMatches(path, ref) {
    if (ref.kind !== 'record' || ref.path !== `.delivery/tasks/${currentTaskId}/ledger.jsonl`)
        return false;
    const raw = readFileSync(path);
    if (!ledgerStructureValid(currentProjectRoot, currentTaskId, currentContractDigest, raw))
        return false;
    let offset = 0;
    while (offset < raw.length) {
        const newline = raw.indexOf(0x0a, offset);
        if (newline < 0 || newline === raw.length - 1)
            break;
        const prefixEnd = newline + 1;
        const prefix = raw.subarray(0, prefixEnd);
        if (sha256(prefix) === ref.sha256 && canonicalDigest(prefix.toString('utf8')) === ref.digest) {
            if (prefixEnd === raw.length
                || !ledgerStructureValid(currentProjectRoot, currentTaskId, currentContractDigest, prefix))
                return false;
            return true;
        }
        offset = prefixEnd;
    }
    return false;
}
function historicalEvidenceMatches(ref) {
    if (ref.kind !== 'authority')
        return false;
    const entry = currentHistoricalEvidence.get(historicalEvidenceKey(ref));
    if (entry === undefined)
        return false;
    const path = resolve(currentProjectRoot, entry.snapshotPath);
    const canonical = safeRegularFile(path);
    return canonical === path
        && sha256(readFileSync(canonical)) === ref.sha256
        && evidenceDigest(canonical) === ref.digest;
}
function evidenceErrors(projectRoot, refs, label) {
    const errors = [];
    if (!sortedIds(refs) || new Set(refs.map((ref) => ref.id)).size !== refs.length) {
        errors.push(`${label}_EVIDENCE_REFS_NOT_UNIQUE_SORTED`);
    }
    for (const ref of refs) {
        const path = resolve(projectRoot, ref.path);
        const relativePath = relative(projectRoot, path);
        if (relativePath.startsWith('..') || relativePath !== ref.path) {
            errors.push(`${label}_EVIDENCE_PATH_INVALID:${ref.id}`);
            continue;
        }
        const canonical = safeRegularFile(path);
        if (canonical === undefined || canonical !== path) {
            errors.push(`${label}_EVIDENCE_PATH_UNSAFE:${ref.id}`);
            continue;
        }
        const raw = readFileSync(canonical);
        const identityMatches = sha256(raw) === ref.sha256 && evidenceDigest(canonical) === ref.digest;
        const ownLedgerPath = ref.path === `.delivery/tasks/${currentTaskId}/ledger.jsonl`;
        if (ownLedgerPath && ref.kind !== 'record') {
            errors.push(`${label}_EVIDENCE_IDENTITY_MISMATCH:${ref.id}`);
            continue;
        }
        const ownLedger = ownLedgerPath;
        if (ownLedger) {
            if (identityMatches
                && ledgerStructureValid(currentProjectRoot, currentTaskId, currentContractDigest, raw))
                continue;
            if (!identityMatches && ledgerPrefixEvidenceMatches(canonical, ref))
                continue;
            errors.push(`${label}_EVIDENCE_IDENTITY_MISMATCH:${ref.id}`);
            continue;
        }
        if (!identityMatches && !historicalEvidenceMatches(ref)) {
            errors.push(`${label}_EVIDENCE_IDENTITY_MISMATCH:${ref.id}`);
        }
    }
    return errors;
}
function checkItemErrors(item, label) {
    const errors = [];
    if (item.status === 'PASS' && item.applicabilityReason !== undefined) {
        errors.push(`${label}_PASS_HAS_APPLICABILITY_REASON`);
    }
    if (item.status === 'NA' && (!item.applicabilityReason || item.applicabilityReason.length === 0)) {
        errors.push(`${label}_NA_REASON_REQUIRED`);
    }
    errors.push(...evidenceErrors(currentProjectRoot, item.evidenceRefs, label));
    return errors;
}
let currentProjectRoot = '';
let currentTaskId = '';
let currentContractDigest = '';
let currentHistoricalEvidence = new Map();
function r3Applicability(contract) {
    if (contract.risk !== 'R3') {
        return {
            trust_threat_analysis: false,
            migration_recovery_rollback: false,
            specialized_gates: false,
            scoped_authorization: false,
            production_observation: false,
        };
    }
    const signals = contract.riskSignals;
    const anySpecialized = [
        'authentication', 'authorization', 'privacy', 'security', 'restrictedRuntime',
        'migration', 'destructive', 'payments', 'externalCommunication',
    ].some((key) => signals[key] === true);
    const anyScopedAuth = contract.authorizationRequirements.length > 0 || [
        'production', 'deployment', 'remoteMutation', 'restrictedRuntime', 'destructive',
        'payments', 'externalCommunication',
    ].some((key) => signals[key] === true);
    return {
        trust_threat_analysis: true,
        migration_recovery_rollback: true,
        specialized_gates: anySpecialized,
        scoped_authorization: anyScopedAuth,
        production_observation: ['production', 'deployment', 'remoteMutation'].some((key) => signals[key] === true),
    };
}
export function verifyContractReadinessArtifact(projectRootInput, taskId, reviewPathInput) {
    const errors = [];
    const projectRoot = realpathSync(resolve(projectRootInput));
    currentProjectRoot = projectRoot;
    currentTaskId = taskId;
    const historicalEvidence = loadHistoricalEvidence(projectRoot);
    errors.push(...historicalEvidence.errors);
    currentHistoricalEvidence = historicalEvidence.valid
        ? historicalEvidence.entries
        : new Map();
    const taskRoot = join(projectRoot, '.delivery', 'tasks', taskId);
    const contractPath = join(taskRoot, 'contract.yaml');
    const canonicalReviewPath = join(taskRoot, 'contract-review.yaml');
    const reviewPath = resolve(reviewPathInput);
    if (reviewPath !== canonicalReviewPath)
        errors.push('CONTRACT_REVIEW_CANONICAL_PATH_MISMATCH');
    const reviewCanonical = safeRegularFile(reviewPath);
    if (reviewCanonical === undefined || reviewCanonical !== reviewPath) {
        return { valid: false, errors: [...errors, 'CONTRACT_REVIEW_ARTIFACT_UNSAFE'] };
    }
    let review;
    try {
        review = parse(readFileSync(reviewCanonical, 'utf8'));
    }
    catch {
        return { valid: false, errors: [...errors, 'CONTRACT_REVIEW_FILE_UNREADABLE'] };
    }
    const schema = validateDocument('contract-review', review);
    if (!schema.valid)
        errors.push(...schema.errors.map((error) => `CONTRACT_REVIEW_SCHEMA_INVALID:${error}`));
    if (!schema.valid || review === null || typeof review !== 'object' || Array.isArray(review)) {
        return { valid: false, errors: [...new Set(errors)].sort(), reviewPath: reviewCanonical };
    }
    const reviewArtifact = review;
    if (reviewArtifact.taskId !== taskId)
        errors.push('CONTRACT_REVIEW_TASK_MISMATCH');
    const contractCanonical = safeRegularFile(contractPath);
    if (contractCanonical === undefined || contractCanonical !== contractPath) {
        return { valid: false, errors: [...errors, 'CONTRACT_REVIEW_CONTRACT_UNSAFE'] };
    }
    let contract;
    const contractRaw = readFileSync(contractCanonical);
    try {
        contract = parse(contractRaw.toString('utf8'));
    }
    catch {
        return { valid: false, errors: [...errors, 'CONTRACT_REVIEW_CONTRACT_UNREADABLE'] };
    }
    currentContractDigest = contract.contractDigest;
    const contractSchema = validateHardenedTaskContract(contract);
    if (!contractSchema.valid)
        errors.push(...contractSchema.errors.map((error) => `CONTRACT_REVIEW_CONTRACT_INVALID:${error}`));
    if (contract.contractReadiness?.required !== true)
        errors.push('CONTRACT_READINESS_NOT_REQUIRED');
    const contractDigest = contract.contractDigest;
    const expectedReviewId = `crv-${taskId}-${contractDigest}`;
    if (reviewArtifact.reviewId !== expectedReviewId)
        errors.push('CONTRACT_REVIEW_ID_MISMATCH');
    if (reviewArtifact.risk !== contract.risk || (contract.risk !== 'R2' && contract.risk !== 'R3'))
        errors.push('CONTRACT_REVIEW_RISK_MISMATCH');
    if (reviewArtifact.contract === undefined || typeof reviewArtifact.contract !== 'object' || reviewArtifact.contract === null || Array.isArray(reviewArtifact.contract)
        || reviewArtifact.contract.path !== contractCanonical || reviewArtifact.contract.rawSha256 !== sha256(contractRaw) || reviewArtifact.contract.digest !== contractDigest) {
        errors.push('CONTRACT_REVIEW_CONTRACT_IDENTITY_MISMATCH');
    }
    try {
        if (reviewArtifact.reviewer === undefined || typeof reviewArtifact.reviewer !== 'object' || reviewArtifact.reviewer === null || Array.isArray(reviewArtifact.reviewer)
            || implementationOwnersOf(contract).includes(normalizeActorId(reviewArtifact.reviewer.id))
            || (typeof contract.contractAuthor === 'string'
                && normalizeActorId(reviewArtifact.reviewer.id) === normalizeActorId(contract.contractAuthor))) {
            errors.push('CONTRACT_REVIEW_SELF_REVIEW_FORBIDDEN');
        }
    }
    catch {
        errors.push('CONTRACT_REVIEW_REVIEWER_INVALID');
    }
    if (isAccountabilityContract(contract, taskId) && reviewArtifact.reviewer?.id !== undefined) {
        try {
            errors.push(...actorEligibilityErrors({
                projectRoot,
                taskId,
                actorId: normalizeActorId(reviewArtifact.reviewer.id),
                role: 'contract-reviewer',
                risk: contract.risk,
            }));
        }
        catch {
            errors.push('CONTRACT_REVIEW_REVIEWER_INVALID');
        }
    }
    for (const key of checklistKeys) {
        const item = reviewArtifact.checklist?.[key];
        if (item === undefined)
            errors.push(`CONTRACT_REVIEW_CHECKLIST_MISSING:${key}`);
        else {
            errors.push(...evidenceErrors(projectRoot, item.evidenceRefs, `CHECKLIST_${key}`));
            if (item.status !== 'PASS')
                errors.push(`CONTRACT_REVIEW_CHECKLIST_NOT_PASS:${key}`);
            if (item.applicabilityReason !== undefined)
                errors.push(`CONTRACT_REVIEW_CHECKLIST_REASON_UNEXPECTED:${key}`);
        }
    }
    if (contract.selfReview !== undefined) {
        errors.push(...assistedReviewErrors(projectRoot, contract.selfReview, reviewArtifact.assistedReview, reviewArtifact.decision));
    }
    else if (reviewArtifact.assistedReview !== undefined) {
        errors.push('CONTRACT_REVIEW_ASSISTED_REVIEW_UNEXPECTED');
    }
    const applicability = r3Applicability(contract);
    for (const key of r3Keys) {
        const item = reviewArtifact.r3Requirements?.[key];
        if (item === undefined) {
            errors.push(`CONTRACT_REVIEW_R3_MISSING:${key}`);
            continue;
        }
        errors.push(...evidenceErrors(projectRoot, item.evidenceRefs, `R3_${key}`));
        if (applicability[key]) {
            if (item.status !== 'PASS')
                errors.push(`CONTRACT_REVIEW_R3_REQUIRED:${key}`);
        }
        else {
            const expectedReason = contract.risk === 'R2'
                ? 'risk-below-r3'
                : key === 'specialized_gates'
                    ? 'no-specialized-signal'
                    : key === 'scoped_authorization'
                        ? 'no-scoped-authorization-action'
                        : 'no-production-action';
            if (item.status !== 'NA' || item.applicabilityReason !== expectedReason) {
                errors.push(`CONTRACT_REVIEW_R3_NA_REASON_INVALID:${key}`);
            }
        }
    }
    if (!findingsOrdered(reviewArtifact.findings)
        || new Set(reviewArtifact.findings.map((finding) => finding.id)).size !== reviewArtifact.findings.length) {
        errors.push('CONTRACT_REVIEW_FINDINGS_NOT_UNIQUE_SEVERITY_SORTED');
    }
    for (const finding of reviewArtifact.findings)
        errors.push(...evidenceErrors(projectRoot, finding.evidenceRefs, `FINDING_${finding.id}`));
    if (isAccountabilityContract(contract, taskId)) {
        for (const finding of reviewArtifact.findings) {
            errors.push(...accountabilityFindingErrors({
                finding: finding,
                taskId,
                ...('implementationOwners' in contract
                    ? { implementationOwners: implementationOwnersOf(contract) }
                    : { implementationOwner: implementationOwnersOf(contract)[0] }),
                ...(typeof contract.contractAuthor === 'string' ? { contractAuthor: contract.contractAuthor } : {}),
            }).map((error) => `CONTRACT_REVIEW_${finding.id}_${error}`));
        }
    }
    if (reviewArtifact.decision === 'ACCEPTED') {
        if (reviewArtifact.findings.length !== 0 || reviewArtifact.nextStage !== 'implementation' || reviewArtifact.userActionRequired) {
            errors.push('CONTRACT_REVIEW_ACCEPTANCE_INVARIANT_INVALID');
        }
    }
    else if (reviewArtifact.findings.length === 0 || reviewArtifact.nextStage !== 'contract-repair') {
        errors.push('CONTRACT_REVIEW_REPAIR_INVARIANT_INVALID');
    }
    const uniqueErrors = [...new Set(errors)].sort();
    return {
        valid: uniqueErrors.length === 0,
        errors: uniqueErrors,
        reviewerId: reviewArtifact.reviewer.id,
        review: reviewArtifact,
        contract,
        reviewPath: reviewCanonical,
    };
}
