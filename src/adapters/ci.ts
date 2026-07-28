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
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { parse, stringify } from 'yaml'

import { governanceIdentity } from '../commands/adopt.js'

interface PortableWrite {
  path: string
  beforeDigest: string | null
  after: Uint8Array
  mode: number
}

export interface PortableGatePlan {
  projectRoot: string
  runnerVersion: string
  runnerDigest: string
  writes: PortableWrite[]
  digest: string
}

function sha256(input: Uint8Array | string): string {
  return createHash('sha256').update(input).digest('hex')
}

function currentDigest(path: string): string | null {
  if (!existsSync(path)) return null
  if (lstatSync(path).isSymbolicLink()) throw new Error(`PORTABLE_TARGET_IS_SYMLINK:${path}`)
  return sha256(readFileSync(path))
}

function plannedWrite(path: string, after: Uint8Array, mode: number): PortableWrite | undefined {
  const beforeDigest = currentDigest(path)
  if (beforeDigest === sha256(after)) return undefined
  return { path, beforeDigest, after, mode }
}

function atomicWrite(write: PortableWrite): void {
  const parent = dirname(write.path)
  mkdirSync(parent, { recursive: true })
  const temporary = join(parent, `.${basename(write.path)}.sop-${process.pid}-${randomUUID()}`)
  const mode = existsSync(write.path) ? lstatSync(write.path).mode : write.mode
  let descriptor: number | undefined
  try {
    descriptor = openSync(temporary, 'wx', mode)
    writeFileSync(descriptor, write.after)
    fsyncSync(descriptor)
    closeSync(descriptor)
    descriptor = undefined
    renameSync(temporary, write.path)
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
    if (existsSync(temporary)) unlinkSync(temporary)
  }
}

function planDigest(plan: Omit<PortableGatePlan, 'digest'>): string {
  return sha256(JSON.stringify({
    projectRoot: plan.projectRoot,
    runnerVersion: plan.runnerVersion,
    runnerDigest: plan.runnerDigest,
    writes: plan.writes.map((write) => ({
      path: write.path,
      beforeDigest: write.beforeDigest,
      afterDigest: sha256(write.after),
      mode: write.mode,
    })),
  }))
}

export function planPortableGate(options: {
  projectRoot: string
  bundlePath: string
}): PortableGatePlan {
  const projectRoot = resolve(options.projectRoot)
  const bundlePath = resolve(options.bundlePath)
  const identity = governanceIdentity()
  const expectedName = `engineering-governance-${identity.version}.tgz`
  if (basename(bundlePath) !== expectedName) throw new Error('RUNNER_ARCHIVE_VERSION_MISMATCH')
  const bundle = readFileSync(bundlePath)
  const runnerDigest = sha256(bundle)
  const runnerRelativePath = `.delivery/runtime/${expectedName}`

  const policyPath = join(projectRoot, '.delivery', 'policy.yaml')
  if (!existsSync(policyPath)) throw new Error('PROJECT_POLICY_MISSING')
  const policy = parse(readFileSync(policyPath, 'utf8')) as Record<string, unknown>
  policy.runner = {
    version: identity.version,
    path: runnerRelativePath,
    sha256: runnerDigest,
  }
  const policyContent = Buffer.from(stringify(policy))
  const wrapper = readFileSync(fileURLToPath(
    new URL('../../templates/ci/check-delivery-policy.sh', import.meta.url),
  ))

  const writes = [
    plannedWrite(policyPath, policyContent, 0o644),
    plannedWrite(join(projectRoot, runnerRelativePath), bundle, 0o644),
    plannedWrite(
      join(projectRoot, '.delivery', 'bin', 'check-delivery-policy.sh'),
      wrapper,
      0o755,
    ),
  ].filter((write): write is PortableWrite => write !== undefined)
  const unsigned = {
    projectRoot,
    runnerVersion: identity.version,
    runnerDigest,
    writes,
  }
  return { ...unsigned, digest: planDigest(unsigned) }
}

export function applyPortableGate(plan: PortableGatePlan, reviewedDigest: string): void {
  if (plan.digest !== reviewedDigest) throw new Error('PORTABLE_PLAN_DIGEST_MISMATCH')
  for (const write of plan.writes) {
    if (currentDigest(write.path) !== write.beforeDigest) {
      throw new Error(`PORTABLE_TARGET_CHANGED:${write.path}`)
    }
  }
  for (const write of plan.writes) atomicWrite(write)
}
