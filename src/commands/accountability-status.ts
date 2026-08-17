import { deriveAccountabilityStatus, type AccountabilityStatus } from '../accountability/derive.js'

export function accountabilityStatus(projectRoot: string, actorOrAlias: string): AccountabilityStatus {
  return deriveAccountabilityStatus(projectRoot, actorOrAlias)
}
