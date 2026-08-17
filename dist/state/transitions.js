import { normalizeActorId } from '../model/actor.js';
import { implementationOwnersOf } from '../model/ownership.js';
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
export function validateAcceptanceAuthority(risk, ownership, reviewOwner) {
    if (risk === 'R0' || risk === 'R1')
        return { valid: true, errors: [] };
    let normalizedOwners;
    let normalizedReviewer;
    try {
        normalizedOwners = Array.isArray(ownership)
            ? ownership.map(normalizeActorId)
            : typeof ownership === 'string'
                ? [normalizeActorId(ownership)]
                : implementationOwnersOf(ownership);
        normalizedReviewer = reviewOwner === undefined ? undefined : normalizeActorId(reviewOwner);
    }
    catch {
        return { valid: false, errors: ['INDEPENDENT_REVIEW_REQUIRED'] };
    }
    if (normalizedReviewer === undefined || normalizedOwners.includes(normalizedReviewer)) {
        return { valid: false, errors: ['INDEPENDENT_REVIEW_REQUIRED'] };
    }
    return { valid: true, errors: [] };
}
