import { applyTaskTransition, planTaskTransition, } from '../state/ledger.js';
const ownerTargets = new Set([
    'IN_PROGRESS',
    'CANDIDATE',
    'BLOCKED',
    'CANCELLED',
    'SUPERSEDED',
]);
function record(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function exactKeys(value, expected) {
    return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}
export function planOwnerTaskTransition(input) {
    if (!record(input) || !exactKeys(input, [
        'schemaVersion',
        'projectRoot',
        'taskId',
        'actorId',
        'to',
        'artifacts',
    ]) || input.schemaVersion !== 2
        || typeof input.projectRoot !== 'string'
        || typeof input.taskId !== 'string'
        || typeof input.actorId !== 'string'
        || typeof input.to !== 'string'
        || !ownerTargets.has(input.to)
        || !Array.isArray(input.artifacts)
        || input.artifacts.length === 0
        || input.artifacts.some((artifact) => (!record(artifact)
            || !exactKeys(artifact, ['kind', 'path'])
            || typeof artifact.kind !== 'string'
            || artifact.kind.length === 0
            || typeof artifact.path !== 'string'
            || artifact.path.length === 0)))
        throw new Error('OWNER_TASK_TRANSITION_INPUT_INVALID');
    return planTaskTransition({
        projectRoot: input.projectRoot,
        taskId: input.taskId,
        actorId: input.actorId,
        to: input.to,
        artifacts: input.artifacts,
    });
}
export function applyOwnerTaskTransition(plan, approvedDigest) {
    return applyTaskTransition(plan, approvedDigest);
}
