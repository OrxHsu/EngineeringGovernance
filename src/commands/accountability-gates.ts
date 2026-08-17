import { loadPermanentGates, type PermanentGatesDocument } from '../accountability/permanent-gates.js'

export function accountabilityGates(projectRoot: string, actorId: string): PermanentGatesDocument {
  return loadPermanentGates(projectRoot, actorId)
}
