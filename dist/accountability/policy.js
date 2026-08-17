import { canonicalDigest } from '../model/digest.js';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';
import { implementationOwnersOf } from '../model/ownership.js';
export const ACCOUNTABILITY_POLICY_VERSION = 'strict-v1';
export const ACCOUNTABILITY_SCORING_VERSION = 'graduated-v2';
export const ACCOUNTABILITY_REGISTRY_PATH = '.delivery/accountability/actors.jsonl';
export const ACCOUNTABILITY_EVENTS_PATH = '.delivery/accountability/events.jsonl';
export const ACCOUNTABILITY_GENESIS_BYTES = 'engineering-governance-accountability-genesis-v1\nstrict-v1\n';
export const ACCOUNTABILITY_GENESIS_DIGEST = 'c6043b1735ad12fa345400d16a9d34c722cea5952821d5e8f00023841d5a9071';
export function accountabilityFindingErrors(input) {
    const finding = input.finding;
    const errors = [];
    const roles = ['contract_author', 'implementation_owner', 'contract_reviewer', 'implementation_reviewer', 'tool', 'none'];
    const culpabilities = ['culpable', 'non_culpable_new_requirement', 'non_culpable_tool_defect', 'missed_existing_blocker'];
    const severities = ['BLOCKER', 'HIGH', 'MEDIUM', 'LOW'];
    if (!severities.includes(finding.severity))
        errors.push('ACCOUNTABILITY_FINDING_SEVERITY_INVALID');
    if (!['contract_violation', 'newly_discovered_defect', 'new_requirement'].includes(String(finding.classification)))
        errors.push('ACCOUNTABILITY_FINDING_CLASSIFICATION_INVALID');
    if (typeof finding.defectClass !== 'string' || finding.defectClass.length === 0)
        errors.push('ACCOUNTABILITY_FINDING_DEFECT_CLASS_REQUIRED');
    if (!roles.includes(finding.responsibleRole))
        errors.push('ACCOUNTABILITY_FINDING_ROLE_INVALID');
    if (!culpabilities.includes(finding.culpability))
        errors.push('ACCOUNTABILITY_FINDING_CULPABILITY_INVALID');
    if (!Object.hasOwn(finding, 'responsibleActorId'))
        errors.push('ACCOUNTABILITY_FINDING_ACTOR_REQUIRED');
    if (typeof finding.origin !== 'object' || finding.origin === null || Array.isArray(finding.origin))
        errors.push('ACCOUNTABILITY_FINDING_ORIGIN_REQUIRED');
    else {
        const origin = finding.origin;
        if (origin.taskId !== input.taskId || typeof origin.artifactPath !== 'string' || !/^[a-f0-9]{64}$/u.test(String(origin.rawSha256)) || !/^[a-f0-9]{64}$/u.test(String(origin.semanticDigest)) || typeof origin.reviewId !== 'string' || !Array.isArray(origin.evidenceRefs))
            errors.push('ACCOUNTABILITY_FINDING_ORIGIN_INVALID');
    }
    if (!Number.isInteger(finding.scoreDelta) || Number(finding.scoreDelta) < 0)
        errors.push('ACCOUNTABILITY_FINDING_SCORE_REQUIRED');
    if (severities.includes(finding.severity) && typeof finding.defectClass === 'string') {
        const nonCulpable = finding.classification === 'new_requirement' || finding.culpability === 'non_culpable_new_requirement' || finding.culpability === 'non_culpable_tool_defect';
        const severity = finding.severity;
        const allowed = nonCulpable
            ? [0]
            : [SEVERITY_POINTS[severity], ...REPEAT_SURCHARGES[severity].map((value) => SEVERITY_POINTS[severity] + value)];
        if (!allowed.includes(Number(finding.scoreDelta)))
            errors.push('ACCOUNTABILITY_FINDING_SCORE_INVALID');
    }
    if (errors.length === 0 && finding.culpability !== 'non_culpable_new_requirement' && finding.culpability !== 'non_culpable_tool_defect') {
        try {
            const expected = responsibleActorForFinding({
                classification: finding.classification,
                responsibleRole: finding.responsibleRole,
                contractAuthor: input.contractAuthor ?? '',
                implementationOwners: implementationOwnersOf(input),
                responsibleActorId: typeof finding.responsibleActorId === 'string' ? finding.responsibleActorId : null,
                culpability: finding.culpability,
            });
            if (expected !== null && normalizeActorForComparison(finding.responsibleActorId) !== normalizeActorForComparison(expected))
                errors.push('ACCOUNTABILITY_FINDING_ACTOR_MISMATCH');
        }
        catch (error) {
            errors.push(error instanceof Error ? error.message : 'ACCOUNTABILITY_FINDING_ATTRIBUTION_INVALID');
        }
    }
    return errors;
}
function normalizeActorForComparison(value) {
    return typeof value === 'string' ? value.trim().normalize('NFKC').toLowerCase() : '';
}
export const SEVERITY_POINTS = {
    BLOCKER: 3,
    HIGH: 2,
    MEDIUM: 1,
    LOW: 0,
};
export const REPEAT_SURCHARGES = {
    BLOCKER: [6, 8, 10, 12],
    HIGH: [5, 6, 7, 8],
    MEDIUM: [3, 4, 5, 6],
    LOW: [1, 1, 2, 2],
};
export function normalizeDefectClass(defectClass) {
    const normalized = defectClass.trim().normalize('NFKC').toLowerCase()
        .replace(/[\s_]+/gu, '-')
        .replace(/[^a-z0-9-]/gu, '')
        .replace(/-+/gu, '-')
        .replace(/^-|-$/gu, '');
    if (normalized.length === 0)
        throw new Error('ACCOUNTABILITY_FINDING_DEFECT_CLASS_INVALID');
    return normalized;
}
function priorOffenseCount(prior, defectClass) {
    if (prior instanceof Map)
        return Math.max(0, prior.get(defectClass) ?? 0);
    return prior.has(defectClass) ? 1 : 0;
}
export function scoreForFinding(severity, defectClass, priorOffenses, classification, culpability) {
    const normalizedClass = normalizeDefectClass(defectClass);
    const base = SEVERITY_POINTS[severity];
    const nonCulpable = classification === 'new_requirement'
        || culpability === 'non_culpable_new_requirement'
        || culpability === 'non_culpable_tool_defect';
    const repeatCount = nonCulpable ? 0 : priorOffenseCount(priorOffenses, normalizedClass);
    const surchargeIndex = Math.min(Math.max(0, repeatCount - 1), REPEAT_SURCHARGES[severity].length - 1);
    const repeatSurcharge = repeatCount === 0 ? 0 : REPEAT_SURCHARGES[severity][surchargeIndex];
    const immediateSuspension = normalizedClass === 'evidence-forgery'
        || normalizedClass === 'identity-evasion'
        || normalizedClass === 'authorization-bypass'
        || normalizedClass === 'prohibited-mutation';
    return {
        base: nonCulpable ? 0 : base,
        repeatSurcharge: nonCulpable ? 0 : repeatSurcharge,
        immediateSuspension,
        delta: nonCulpable ? 0 : base + repeatSurcharge,
        defectClass: normalizedClass,
        isFirstOffense: repeatCount === 0,
        repeatCount,
    };
}
export function standingForScore(activePenaltyScore, forcedSuspended = false) {
    if (forcedSuspended || activePenaltyScore >= 12)
        return 'SUSPENDED';
    if (activePenaltyScore >= 8)
        return 'PROBATION';
    if (activePenaltyScore >= 5)
        return 'WATCH';
    if (activePenaltyScore >= 3)
        return 'WARNING';
    return 'GOOD_STANDING';
}
export function permissionsForStanding(standing) {
    if (standing === 'GOOD_STANDING')
        return ['author', 'owner', 'contract-reviewer', 'implementation-reviewer', 'supervise'];
    if (standing === 'WARNING')
        return ['r0', 'r1', 'r2-supervised'];
    if (standing === 'WATCH')
        return ['r0', 'r1', 'r2-supervised'];
    if (standing === 'PROBATION')
        return ['r0', 'remediation-supervised'];
    return ['r0'];
}
export function canonicalPolicyDigest() {
    return canonicalDigest({
        policyVersion: ACCOUNTABILITY_POLICY_VERSION,
        registryPath: ACCOUNTABILITY_REGISTRY_PATH,
        eventsPath: ACCOUNTABILITY_EVENTS_PATH,
        genesisDigest: ACCOUNTABILITY_GENESIS_DIGEST,
    });
}
export function assertAccountabilityPolicy(projectRoot) {
    let parsed;
    try {
        parsed = parse(readFileSync(join(resolve(projectRoot), '.delivery', 'policy.yaml'), 'utf8'));
    }
    catch {
        throw new Error('ACCOUNTABILITY_POLICY_INVALID');
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
        throw new Error('ACCOUNTABILITY_POLICY_INVALID');
    const mapping = parsed.artifactMapping;
    if (typeof mapping !== 'object' || mapping === null || Array.isArray(mapping))
        throw new Error('ACCOUNTABILITY_POLICY_BINDING_INVALID');
    const value = mapping;
    if (value['accountability.ruleset'] !== ACCOUNTABILITY_POLICY_VERSION
        || value['accountability.registryPath'] !== ACCOUNTABILITY_REGISTRY_PATH
        || value['accountability.eventsPath'] !== ACCOUNTABILITY_EVENTS_PATH
        || value['accountability.genesisDigest'] !== ACCOUNTABILITY_GENESIS_DIGEST) {
        throw new Error('ACCOUNTABILITY_POLICY_BINDING_INVALID');
    }
}
export function normalizeFindingClassification(value) {
    if (value === 'contract_violation' || value === 'newly_discovered_defect' || value === 'new_requirement')
        return value;
    throw new Error('ACCOUNTABILITY_FINDING_CLASSIFICATION_INVALID');
}
export function responsibleActorForFinding(input) {
    if (input.culpability === 'non_culpable_new_requirement' || input.culpability === 'non_culpable_tool_defect')
        return null;
    if (input.culpability === 'missed_existing_blocker') {
        if (!input.priorReviewer)
            throw new Error('ACCOUNTABILITY_PRIOR_REVIEWER_REQUIRED');
        return input.priorReviewer;
    }
    if (input.classification === 'contract_violation' && input.responsibleRole === 'contract_author')
        return input.contractAuthor;
    if (input.classification === 'newly_discovered_defect' && input.responsibleRole === 'implementation_owner') {
        const owners = implementationOwnersOf(input);
        if (owners.length === 1)
            return owners[0];
        const selected = normalizeActorForComparison(input.responsibleActorId);
        if (owners.includes(selected))
            return selected;
        throw new Error('ACCOUNTABILITY_IMPLEMENTATION_OWNER_SELECTION_REQUIRED');
    }
    throw new Error('ACCOUNTABILITY_ROLE_ATTRIBUTION_INVALID');
}
