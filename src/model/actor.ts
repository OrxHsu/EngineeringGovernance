export function normalizeActorId(value: string): string {
  const normalized = value.trim().normalize('NFKC').toLowerCase()
  if (!/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/u.test(normalized)) {
    throw new Error('ACTOR_ID_INVALID')
  }
  return normalized
}
