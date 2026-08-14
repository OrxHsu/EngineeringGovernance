import { normalizeActorId } from '../model/actor.js';
const transitions = {
    DEFINED: ['IN_PROGRESS', 'BLOCKED', 'CANCELLED', 'SUPERSEDED'],
    IN_PROGRESS: ['CANDIDATE', 'BLOCKED', 'CANCELLED', 'SUPERSEDED'],
    CANDIDATE: ['ACCEPTED', 'REPAIR_REQUIRED', 'BLOCKED', 'CANCELLED', 'SUPERSEDED'],
    REPAIR_REQUIRED: ['IN_PROGRESS', 'BLOCKED', 'CANCELLED', 'SUPERSEDED'],
    BLOCKED: ['IN_PROGRESS', 'CANCELLED', 'SUPERSEDED'],
    ACCEPTED: ['CLOSED'],
    CLOSED: [],
    CANCELLED: [],
    SUPERSEDED: [],
};
export function canTransition(from, to) {
    return transitions[from].includes(to);
}
export function validateAcceptanceAuthority(risk, implementationOwner, reviewOwner) {
    if (risk === 'R0' || risk === 'R1')
        return { valid: true, errors: [] };
    let normalizedOwner;
    let normalizedReviewer;
    try {
        normalizedOwner = normalizeActorId(implementationOwner);
        normalizedReviewer = reviewOwner === undefined ? undefined : normalizeActorId(reviewOwner);
    }
    catch {
        return { valid: false, errors: ['INDEPENDENT_REVIEW_REQUIRED'] };
    }
    if (normalizedReviewer === undefined || normalizedReviewer === normalizedOwner) {
        return { valid: false, errors: ['INDEPENDENT_REVIEW_REQUIRED'] };
    }
    return { valid: true, errors: [] };
}
