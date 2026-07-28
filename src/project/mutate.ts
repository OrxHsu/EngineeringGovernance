import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
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
  after: string
}

export interface MutationResult {
  applied: string[]
}

function digest(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function currentDigest(path: string): string | null {
  if (!existsSync(path)) return null
  if (lstatSync(path).isSymbolicLink()) throw new Error(`MANAGED_PATH_IS_SYMLINK:${path}`)
  return digest(readFileSync(path, 'utf8'))
}

function atomicWrite(path: string, content: string): void {
  const parent = dirname(path)
  mkdirSync(parent, { recursive: true })
  const temporary = join(parent, `.${basename(path)}.sop-${process.pid}-${randomUUID()}`)
  const mode = existsSync(path) ? lstatSync(path).mode : 0o644
  let descriptor: number | undefined
  try {
    descriptor = openSync(temporary, 'wx', mode)
    writeFileSync(descriptor, content, 'utf8')
    fsyncSync(descriptor)
    closeSync(descriptor)
    descriptor = undefined
    renameSync(temporary, path)
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
    atomicWrite(write.path, write.after)
    applied.push(write.path)
  }
  return { applied }
}
