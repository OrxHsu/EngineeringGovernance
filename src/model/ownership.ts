import { normalizeActorId } from './actor.js'

export interface OwnershipFields {
  implementationOwner?: unknown
  implementationOwners?: unknown
}

/**
 * New contracts use an ordered owner set. Legacy contracts with one
 * implementationOwner remain readable and are normalized to a one-item set.
 */
export function implementationOwnersOf(value: OwnershipFields): string[] {
  const hasLegacy = Object.hasOwn(value, 'implementationOwner') && value.implementationOwner !== undefined
  const hasPlural = Object.hasOwn(value, 'implementationOwners') && value.implementationOwners !== undefined
  if (hasLegacy === hasPlural) throw new Error('TASK_IMPLEMENTATION_OWNER_FIELDS_INVALID')

  const raw = hasPlural ? value.implementationOwners : [value.implementationOwner]
  if (!Array.isArray(raw) || raw.length === 0) throw new Error('TASK_IMPLEMENTATION_OWNERS_REQUIRED')
  if (raw.some((owner) => typeof owner !== 'string')) throw new Error('TASK_IMPLEMENTATION_OWNER_INVALID')
  let owners: string[]
  try {
    owners = raw.map((owner) => normalizeActorId(owner as string))
  } catch {
    throw new Error('TASK_IMPLEMENTATION_OWNER_INVALID')
  }
  if (owners.some((owner) => owner.length === 0) || new Set(owners).size !== owners.length) {
    throw new Error('TASK_IMPLEMENTATION_OWNERS_DUPLICATED')
  }
  return [...owners].sort()
}

export function isImplementationOwner(value: OwnershipFields, actorId: string): boolean {
  const actor = normalizeActorId(actorId)
  return implementationOwnersOf(value).includes(actor)
}

export function primaryImplementationOwner(value: OwnershipFields): string {
  return implementationOwnersOf(value)[0]!
}
