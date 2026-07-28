import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fchmodSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'

export interface PlannedWrite {
  path: string
  beforeDigest: string | null
  after: string | Uint8Array
  mode?: number
}

export interface MutationResult {
  applied: string[]
}

export interface PlannedGuard {
  path: string
  beforeDigest: string | null
}

function digest(content: string | Uint8Array): string {
  return createHash('sha256').update(content).digest('hex')
}

function currentDigest(path: string): string | null {
  if (!existsSync(path)) return null
  if (lstatSync(path).isSymbolicLink()) throw new Error(`MANAGED_PATH_IS_SYMLINK:${path}`)
  return digest(readFileSync(path))
}

export function assertPlannedGuardsUnchanged(guards: PlannedGuard[]): void {
  for (const guard of guards) {
    if (currentDigest(guard.path) !== guard.beforeDigest) {
      throw new Error(`MANAGED_FILE_CHANGED:${guard.path}`)
    }
  }
}

function atomicWrite(write: PlannedWrite): void {
  const parent = dirname(write.path)
  mkdirSync(parent, { recursive: true })
  const temporary = join(parent, `.${basename(write.path)}.sop-${process.pid}-${randomUUID()}`)
  const mode = write.mode ?? (existsSync(write.path) ? lstatSync(write.path).mode & 0o777 : 0o644)
  let descriptor: number | undefined
  try {
    descriptor = openSync(temporary, 'wx', mode)
    if (typeof write.after === 'string') writeFileSync(descriptor, write.after, 'utf8')
    else writeFileSync(descriptor, write.after)
    fchmodSync(descriptor, mode)
    fsyncSync(descriptor)
    closeSync(descriptor)
    descriptor = undefined
    renameSync(temporary, write.path)
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
    if (existsSync(temporary)) unlinkSync(temporary)
  }
}

export function applyPlannedWrites(
  writes: PlannedWrite[],
  options: { dryRun: boolean },
): MutationResult {
  if (options.dryRun) return { applied: [] }

  for (const write of writes) {
    if (currentDigest(write.path) !== write.beforeDigest) {
      throw new Error(`MANAGED_FILE_CHANGED:${write.path}`)
    }
  }

  const applied: string[] = []
  for (const write of writes) {
    atomicWrite(write)
    applied.push(write.path)
  }
  return { applied }
}
