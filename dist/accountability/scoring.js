import { scoreForFinding, standingForScore, } from './policy.js';
export function calculatePenalty(finding, history) {
    const counts = new Map();
    for (const prior of history.findings) {
        const normalized = prior.defectClass.trim().normalize('NFKC').toLowerCase()
            .replace(/[\s_]+/gu, '-')
            .replace(/[^a-z0-9-]/gu, '')
            .replace(/-+/gu, '-')
            .replace(/^-|-$/gu, '');
        counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
    }
    const score = scoreForFinding(finding.severity, finding.defectClass, counts, finding.classification ?? 'newly_discovered_defect', finding.culpability ?? 'culpable');
    return {
        ...score,
        baseScore: score.base,
        repeatPenalty: score.repeatSurcharge,
        totalDelta: score.delta,
    };
}
export function deriveStanding(activeScore, forcedSuspended = false) {
    return standingForScore(activeScore, forcedSuspended);
}
