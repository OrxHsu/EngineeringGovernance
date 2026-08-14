import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { lstatSync, readFileSync, readlinkSync, realpathSync } from 'node:fs'
import { join } from 'node:path'

import { canonicalDigest } from '../model/digest.js'

export interface CheckoutSnapshot {
  id: string
  repository: string
  head: string
  tree: string
  trackedDiffSha256: string
  trackedPaths: string[]
  untracked: Array<{ path: string; type: 'file' | 'symlink'; sha256: string }>
  statusDigest: string
}

function sha256(input: string | Uint8Array): string {
  return createHash('sha256').update(input).digest('hex')
}

function git(repository: string, arguments_: string[], encoding: BufferEncoding | 'buffer' = 'utf8'):
string | Buffer {
  return execFileSync('git', ['-C', repository, ...arguments_], {
    encoding: encoding === 'buffer' ? 'buffer' : encoding,
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  })
}

function untrackedFiles(repository: string): CheckoutSnapshot['untracked'] {
  const output = git(repository, ['ls-files', '--others', '--exclude-standard', '-z'], 'buffer') as Buffer
  return output.toString('utf8').split('\0').filter(Boolean).sort().map((path) => {
    const absolute = join(repository, path)
    const stat = lstatSync(absolute)
    if (stat.isSymbolicLink()) {
      return { path, type: 'symlink' as const, sha256: sha256(readlinkSync(absolute)) }
    }
    if (!stat.isFile()) throw new Error(`CHECKOUT_UNTRACKED_PATH_UNSUPPORTED:${path}`)
    return { path, type: 'file' as const, sha256: sha256(readFileSync(absolute)) }
  })
}

export function captureCheckoutSnapshot(input: { id: string; path: string }): CheckoutSnapshot {
  const repository = realpathSync(input.path)
  const head = (git(repository, ['rev-parse', 'HEAD']) as string).trim()
  const tree = (git(repository, ['rev-parse', 'HEAD^{tree}']) as string).trim()
  const trackedDiff = git(repository, ['diff', '--binary', 'HEAD', '--'], 'buffer') as Buffer
  const trackedPaths = (git(repository, ['diff', '--name-only', '-z', 'HEAD', '--'], 'buffer') as Buffer)
    .toString('utf8').split('\0').filter(Boolean).sort()
  const trackedDiffSha256 = sha256(trackedDiff)
  const untracked = untrackedFiles(repository)
  return {
    id: input.id,
    repository,
    head,
    tree,
    trackedDiffSha256,
    trackedPaths,
    untracked,
    statusDigest: canonicalDigest({ trackedDiffSha256, trackedPaths, untracked }),
  }
}

export function captureRepositorySet(
  repositories: Array<{ id: string; path: string }>,
): CheckoutSnapshot[] {
  return [...repositories]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map(captureCheckoutSnapshot)
}
