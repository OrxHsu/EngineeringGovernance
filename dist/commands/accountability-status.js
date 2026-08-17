import { deriveAccountabilityStatus } from '../accountability/derive.js';
export function accountabilityStatus(projectRoot, actorOrAlias) {
    return deriveAccountabilityStatus(projectRoot, actorOrAlias);
}
