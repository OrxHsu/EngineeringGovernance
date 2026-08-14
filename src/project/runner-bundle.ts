import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'

const tarExecutable = '/usr/bin/tar'

function sha256(input: string | Uint8Array): string {
  return createHash('sha256').update(input).digest('hex')
}

function archiveEntries(archivePath: string): string[] {
  const output = execFileSync(tarExecutable, ['-tzf', archivePath], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const entries = output.split('\n').filter(Boolean)
  if (entries.some((entry) => (
    entry.startsWith('/')
    || entry.split('/').includes('..')
    || entry.includes('\\')
  ))) throw new Error('RUNNER_ARCHIVE_PATH_UNSAFE')
  return entries
}

function readArchiveFile(archivePath: string, relativePath: string, entries: string[]): Buffer {
  if (relativePath.startsWith('/') || relativePath.split('/').includes('..')) {
    throw new Error(`RUNNER_ARCHIVE_ENTRY_INVALID:${relativePath}`)
  }
  const entry = `package/${relativePath}`
  const occurrences = entries.filter((candidate) => candidate === entry).length
  if (occurrences !== 1) throw new Error(`RUNNER_ARCHIVE_ENTRY_INVALID:${relativePath}:${occurrences}`)
  return execFileSync(tarExecutable, ['-xOf', archivePath, entry], {
    encoding: null,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

export function readRunnerArchiveFile(archivePath: string, relativePath: string): Buffer {
  return readArchiveFile(archivePath, relativePath, archiveEntries(archivePath))
}

export function validateRunnerBundleIdentity(input: {
  archivePath: string
  expectedVersion: string
  identitySources: Array<{ path: string; sha256: string }>
  dependencySources: Array<{ path: string; sha256: string }>
}): void {
  const entries = archiveEntries(input.archivePath)
  const requiredPaths = [...new Set([
    'package.json',
    'VERSION',
    ...input.identitySources.map((source) => source.path),
    ...input.dependencySources.map((source) => source.path),
  ])].sort()
  for (const path of requiredPaths) {
    const occurrences = entries.filter((entry) => entry === `package/${path}`).length
    if (occurrences !== 1) throw new Error(`RUNNER_ARCHIVE_ENTRY_INVALID:${path}:${occurrences}`)
  }
  const extractionRoot = realpathSync(mkdtempSync(join(tmpdir(), 'sop-runner-inspect-')))
  try {
    execFileSync(tarExecutable, [
      '-xzf', input.archivePath,
      '-C', extractionRoot,
      ...requiredPaths.map((path) => `package/${path}`),
    ], {
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const read = (path: string): Buffer => {
      const unresolved = join(extractionRoot, 'package', path)
      if (lstatSync(unresolved).isSymbolicLink() || !lstatSync(unresolved).isFile()) {
        throw new Error(`RUNNER_ARCHIVE_ENTRY_UNSAFE:${path}`)
      }
      const canonical = realpathSync(unresolved)
      const relativePath = relative(extractionRoot, canonical)
      if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
        throw new Error(`RUNNER_ARCHIVE_ENTRY_UNSAFE:${path}`)
      }
      return readFileSync(canonical)
    }
    let packageDocument: {
      name?: unknown
      version?: unknown
      type?: unknown
      bin?: unknown
    }
    try {
      packageDocument = JSON.parse(
        read('package.json').toString('utf8'),
      ) as typeof packageDocument
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('RUNNER_ARCHIVE_')) throw error
      throw new Error('RUNNER_ARCHIVE_PACKAGE_INVALID')
    }
    if (
      packageDocument.name !== '@xgh/engineering-governance'
      || packageDocument.version !== input.expectedVersion
      || packageDocument.type !== 'module'
      || JSON.stringify(packageDocument.bin) !== JSON.stringify({ sop: 'dist/cli/main.js' })
      || read('VERSION').toString('utf8').trim() !== input.expectedVersion
    ) throw new Error('RUNNER_ARCHIVE_PACKAGE_IDENTITY_MISMATCH')

    for (const source of input.identitySources) {
      const archived = read(source.path)
      if (sha256(archived) !== source.sha256) {
        const code = source.path.startsWith('node_modules/')
          ? 'RUNNER_ARCHIVE_DEPENDENCY_MISMATCH'
          : 'RUNNER_ARCHIVE_IDENTITY_SOURCE_MISMATCH'
        throw new Error(`${code}:${source.path}`)
      }
    }
    for (const source of input.dependencySources) {
      const archived = read(source.path)
      if (sha256(archived) !== source.sha256) {
        throw new Error(`RUNNER_ARCHIVE_DEPENDENCY_MISMATCH:${source.path}`)
      }
    }
  } finally {
    rmSync(extractionRoot, { recursive: true, force: true })
  }
}
