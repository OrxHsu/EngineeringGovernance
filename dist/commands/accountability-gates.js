import { loadPermanentGates } from '../accountability/permanent-gates.js';
export function accountabilityGates(projectRoot, actorId) {
    return loadPermanentGates(projectRoot, actorId);
}
