import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, realpathSync, unlinkSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'

import { parse } from 'yaml'

import { MANAGED_BLOCK_END, MANAGED_BLOCK_START } from '../adapters/render.js'
import { canonicalDigest } from '../model/digest.js'
import { validateProjectPolicy } from '../policy/load.js'
import { applyPlannedWrites, type PlannedWrite } from '../project/mutate.js'
import { readRunnerArchiveFile } from '../project/runner-bundle.js'
import { loadProjectExtensions } from '../extensions/registry.js'

interface ProjectPolicy {
  sopVersion: string
  adapters: Array<{ source: string; targets: string[]; digest: string }>
  runner?: { version: string; path: string; sha256: string }
}

interface PlannedRemoval {
  path: string
  beforeDigest: string
}

export interface UnadoptionPlan {
  schemaVersion: 1
  projectRoot: string
  writes: PlannedWrite[]
  removals: PlannedRemoval[]
  digest: string
}

function sha256(input: string | Uint8Array): string {
  return createHash('sha256').update(input).digest('hex')
}

function safeProjectFile(root: string, relativePath: string): string {
  if (isAbsolute(relativePath) || relativePath.split('/').includes('..')) {
    throw new Error(`UNADOPTION_PATH_INVALID:${relativePath}`)
  }
  const unresolved = join(root, relativePath)
  if (!existsSync(unresolved) || lstatSync(unresolved).isSymbolicLink() || !lstatSync(unresolved).isFile()) {
    throw new Error(`UNADOPTION_TARGET_UNSAFE:${relativePath}`)
  }
  const path = realpathSync(unresolved)
  const relativeCanonical = relative(root, path)
  if (relativeCanonical.startsWith('..') || isAbsolute(relativeCanonical)) {
    throw new Error(`UNADOPTION_PATH_OUTSIDE_PROJECT:${relativePath}`)
  }
  return path
}

function removeManagedBlock(content: string, expectedDigest: string): string {
  const starts = content.split(MANAGED_BLOCK_START).length - 1
  const ends = content.split(MANAGED_BLOCK_END).length - 1
  if (starts !== 1 || ends !== 1) throw new Error('UNADOPTION_MANAGED_BLOCK_MALFORMED')
  const start = content.indexOf(MANAGED_BLOCK_START)
  const end = content.indexOf(MANAGED_BLOCK_END) + MANAGED_BLOCK_END.length
  if (sha256(content.slice(start, end).trimEnd()) !== expectedDigest) {
    throw new Error('UNADOPTION_MANAGED_BLOCK_DRIFTED')
  }
  let suffix = content.slice(end)
  if (suffix.startsWith('\n\n')) suffix = suffix.slice(2)
  else if (suffix.startsWith('\n')) suffix = suffix.slice(1)
  return `${content.slice(0, start)}${suffix}`
}

function validateUnadoptionExtensions(projectRoot: string): void {
  const path = safeProjectFile(projectRoot, '.delivery/extensions.yaml')
  const manifest = parse(readFileSync(path, 'utf8')) as {
    schemaVersion?: unknown
    extensions?: unknown
  }
  if (manifest.schemaVersion === 2) {
    loadProjectExtensions(projectRoot)
    return
  }
  const keys = Object.keys(manifest).sort()
  if (
    manifest.schemaVersion !== 1
    || JSON.stringify(keys) !== JSON.stringify(['extensions', 'schemaVersion'])
    || !Array.isArray(manifest.extensions)
    || manifest.extensions.length !== 0
  ) throw new Error('UNADOPTION_EXTENSIONS_INVALID')
}

function removal(path: string): PlannedRemoval {
  return { path, beforeDigest: sha256(readFileSync(path)) }
}

export function planUnadoption(projectPath: string): UnadoptionPlan {
  const projectRoot = realpathSync(resolve(projectPath))
  const policyPath = safeProjectFile(projectRoot, '.delivery/policy.yaml')
  const policy = parse(readFileSync(policyPath, 'utf8')) as ProjectPolicy
  const schema = validateProjectPolicy(policy)
  if (!schema.valid) throw new Error(`UNADOPTION_POLICY_INVALID:${schema.errors.join(',')}`)
  validateUnadoptionExtensions(projectRoot)
  const adapterDigests = new Map<string, string>()
  for (const adapter of policy.adapters) {
    for (const path of [adapter.source, ...adapter.targets]) {
      const previous = adapterDigests.get(path)
      if (previous !== undefined && previous !== adapter.digest) {
        throw new Error(`UNADOPTION_ADAPTER_DIGEST_CONFLICT:${path}`)
      }
      adapterDigests.set(path, adapter.digest)
    }
  }
  const adapterPaths = [...adapterDigests.keys()].sort()
  const writes = adapterPaths.map((relativePath) => {
    const path = safeProjectFile(projectRoot, relativePath)
    const before = readFileSync(path, 'utf8')
    return {
      path,
      beforeDigest: sha256(before),
      after: removeManagedBlock(before, adapterDigests.get(relativePath)!),
    }
  })
  const runnerRemovalPaths: string[] = []
  if (policy.runner !== undefined) {
    const archivePath = safeProjectFile(projectRoot, policy.runner.path)
    if (sha256(readFileSync(archivePath)) !== policy.runner.sha256) {
      throw new Error('UNADOPTION_RUNNER_DRIFTED')
    }
    if (
      policy.runner.version !== policy.sopVersion
      || readRunnerArchiveFile(archivePath, 'VERSION').toString('utf8').trim() !== policy.runner.version
    ) throw new Error('UNADOPTION_RUNNER_IDENTITY_MISMATCH')
    const wrapperPath = safeProjectFile(projectRoot, '.delivery/bin/check-delivery-policy.sh')
    const expectedWrapper = readRunnerArchiveFile(
      archivePath,
      'templates/ci/check-delivery-policy.sh',
    )
    if (
      sha256(readFileSync(wrapperPath)) !== sha256(expectedWrapper)
      || (lstatSync(wrapperPath).mode & 0o777) !== 0o755
    ) throw new Error('UNADOPTION_WRAPPER_DRIFTED')
    runnerRemovalPaths.push(archivePath, wrapperPath)
  }
  const removalPaths = [
    safeProjectFile(projectRoot, '.delivery/policy.yaml'),
    safeProjectFile(projectRoot, '.delivery/extensions.yaml'),
    ...runnerRemovalPaths,
  ]
  const removals = [...new Set(removalPaths)].sort().map(removal)
  const unsigned = {
    schemaVersion: 1 as const,
    projectRoot,
    writes,
    removals,
  }
  return { ...unsigned, digest: canonicalDigest(unsigned) }
}

export function summarizeUnadoptionPlan(plan: UnadoptionPlan): object {
  return {
    projectRoot: plan.projectRoot,
    digest: plan.digest,
    writes: plan.writes.map((write) => ({
      path: write.path,
      beforeDigest: write.beforeDigest,
      afterDigest: sha256(write.after),
    })),
    removals: plan.removals,
    preserved: ['.delivery/tasks/**', '.delivery/evidence/**', 'unrecognized project files'],
  }
}

export function applyUnadoption(
  plan: UnadoptionPlan,
  reviewedDigest: string,
): { applied: string[] } {
  const { digest, ...unsigned } = plan
  if (reviewedDigest !== digest || canonicalDigest(unsigned) !== digest) {
    throw new Error('UNADOPTION_PLAN_DIGEST_MISMATCH')
  }
  for (const write of plan.writes) {
    if (!existsSync(write.path) || lstatSync(write.path).isSymbolicLink()
      || sha256(readFileSync(write.path)) !== write.beforeDigest) {
      throw new Error(`UNADOPTION_TARGET_CHANGED:${write.path}`)
    }
  }
  for (const item of plan.removals) {
    if (!existsSync(item.path) || lstatSync(item.path).isSymbolicLink()
      || !lstatSync(item.path).isFile() || sha256(readFileSync(item.path)) !== item.beforeDigest) {
      throw new Error(`UNADOPTION_TARGET_CHANGED:${item.path}`)
    }
  }
  const writes = applyPlannedWrites(plan.writes, { dryRun: false }).applied
  for (const item of plan.removals) unlinkSync(item.path)
  return { applied: [...writes, ...plan.removals.map((item) => item.path)] }
}
