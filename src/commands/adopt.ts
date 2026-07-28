import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs'
import { basename, join, resolve, sep } from 'node:path'

import { parse, stringify } from 'yaml'

import { canonicalDigest } from '../model/digest.js'
import type { ValidationResult } from '../model/types.js'
import { validateDocument, validateProjectPolicy } from '../policy/load.js'
import { adoptionProfile } from '../project/adoption-profile.js'
import { discoverProject, validateManagedPathOverlap } from '../project/discover.js'
import { createManagedBlock, planManagedBlockWrite } from '../project/managed-block.js'
import type { PlannedWrite } from '../project/mutate.js'
import { MANAGED_BLOCK_END, MANAGED_BLOCK_START } from '../adapters/render.js'

export interface AdoptionPlan {
  projectRoot: string
  writes: PlannedWrite[]
  digest: string
}

export function summarizeAdoptionPlan(plan: AdoptionPlan): object {
  return {
    projectRoot: plan.projectRoot,
    digest: plan.digest,
    writes: plan.writes.map((write) => ({
      path: write.path,
      beforeDigest: write.beforeDigest,
      afterDigest: sha256(write.after),
      ...(write.mode === undefined ? {} : { mode: write.mode }),
    })),
  }
}

function sha256(input: string | Uint8Array): string {
  return createHash('sha256').update(input).digest('hex')
}

function governanceFile(path: string): string {
  return readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')
}

export function governanceIdentity(): { version: string; digest: string } {
  const version = governanceFile('VERSION').trim()
  const digest = sha256([
    governanceFile('CORE_INVARIANTS.md'),
    governanceFile('DEVELOPMENT_SOP.md'),
    governanceFile('RISK_CLASSIFICATION.md'),
    version,
  ].join('\n--governance-source--\n'))
  return { version, digest }
}

function planFileWrite(
  path: string,
  after: string | Uint8Array,
  mode?: number,
): PlannedWrite {
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
    throw new Error(`MANAGED_PATH_IS_SYMLINK:${path}`)
  }
  const before = existsSync(path) ? readFileSync(path) : undefined
  return {
    path,
    beforeDigest: before === undefined ? null : sha256(before),
    after,
    ...(mode === undefined ? {} : { mode }),
  }
}

function planDigest(projectRoot: string, writes: PlannedWrite[]): string {
  return sha256(JSON.stringify({
    projectRoot,
    writes: writes.map((write) => ({
      path: write.path,
      beforeDigest: write.beforeDigest,
      afterDigest: sha256(write.after),
      mode: write.mode,
    })),
  }))
}

interface PolicyAdapter {
  tool: string
  source: string
  targets: string[]
  digest: string
}

interface ProjectPolicy {
  sopVersion: string
  sopDigest: string
  projectId: string
  adapters: PolicyAdapter[]
  runner?: { version: string; path: string; sha256: string }
  [key: string]: unknown
}

function managedBlockMatches(path: string, expectedBlock: string): boolean {
  if (!existsSync(path) || lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile()) {
    return false
  }
  const text = readFileSync(path, 'utf8')
  const starts = text.split(MANAGED_BLOCK_START).length - 1
  const ends = text.split(MANAGED_BLOCK_END).length - 1
  if (starts !== 1 || ends !== 1) return false
  const start = text.indexOf(MANAGED_BLOCK_START)
  const end = text.indexOf(MANAGED_BLOCK_END) + MANAGED_BLOCK_END.length
  return text.slice(start, end) === expectedBlock
}

function validateExtensions(projectRoot: string): string[] {
  const path = join(projectRoot, '.delivery', 'extensions.yaml')
  if (!existsSync(path)) return ['PROJECT_EXTENSIONS_MISSING']
  try {
    const document = parse(readFileSync(path, 'utf8')) as unknown
    if (typeof document !== 'object' || document === null || Array.isArray(document)) {
      return ['PROJECT_EXTENSIONS_INVALID']
    }
    const record = document as Record<string, unknown>
    const keys = Object.keys(record).sort()
    if (
      record.schemaVersion !== 1
      || !Array.isArray(record.extensions)
      || !record.extensions.every((extension) => (
        typeof extension === 'object' && extension !== null && !Array.isArray(extension)
      ))
      || JSON.stringify(keys) !== JSON.stringify(['extensions', 'schemaVersion'])
    ) return ['PROJECT_EXTENSIONS_INVALID']
    return []
  } catch {
    return ['PROJECT_EXTENSIONS_INVALID']
  }
}

function adapterInventoryErrors(
  projectRoot: string,
  policy: ProjectPolicy,
  expectedBlock: string,
): string[] {
  const errors: string[] = []
  const expectedProfile = adoptionProfile(projectRoot)
  if (policy.projectId !== expectedProfile.projectId) errors.push('PROJECT_ID_MISMATCH')
  if (!Array.isArray(policy.adapters)) return ['PROJECT_ADAPTER_INVENTORY_MISMATCH']

  const expectedInventory = expectedProfile.adapters.map((adapter) => ({
    tool: adapter.tool,
    source: adapter.source,
    targets: adapter.targets,
  }))
  const actualInventory = policy.adapters.map((adapter) => ({
    tool: adapter.tool,
    source: adapter.source,
    targets: adapter.targets,
  }))
  if (JSON.stringify(actualInventory) !== JSON.stringify(expectedInventory)) {
    errors.push('PROJECT_ADAPTER_INVENTORY_MISMATCH')
    return errors
  }

  const expectedDigest = sha256(expectedBlock)
  for (const adapter of policy.adapters) {
    if (adapter.digest !== expectedDigest) {
      errors.push(`AGENT_ADAPTER_POLICY_DIGEST_MISMATCH:${adapter.source}`)
    }
    if (!managedBlockMatches(join(projectRoot, adapter.source), expectedBlock)) {
      errors.push(`AGENT_ADAPTER_SOURCE_DRIFTED:${adapter.source}`)
    }
    for (const target of adapter.targets) {
      if (!managedBlockMatches(join(projectRoot, target), expectedBlock)) {
        errors.push(`AGENT_ADAPTER_TARGET_DRIFTED:${target}`)
      }
    }
  }
  return errors
}

function runnerErrors(projectRoot: string, policy: ProjectPolicy, expectedVersion: string): string[] {
  if (policy.runner === undefined) return ['PROJECT_RUNNER_MISSING']
  const errors: string[] = []
  if (policy.runner.version !== expectedVersion) errors.push('PROJECT_RUNNER_VERSION_MISMATCH')
  const runnerPath = resolve(projectRoot, policy.runner.path)
  if (!runnerPath.startsWith(`${projectRoot}${sep}`)) {
    return [...errors, 'PROJECT_RUNNER_PATH_INVALID']
  }
  if (
    !existsSync(runnerPath)
    || lstatSync(runnerPath).isSymbolicLink()
    || !lstatSync(runnerPath).isFile()
  ) {
    errors.push('PROJECT_RUNNER_MISSING_OR_UNSAFE')
  } else if (sha256(readFileSync(runnerPath)) !== policy.runner.sha256) {
    errors.push('PROJECT_RUNNER_DIGEST_MISMATCH')
  }

  const wrapperPath = join(projectRoot, '.delivery', 'bin', 'check-delivery-policy.sh')
  if (
    !existsSync(wrapperPath)
    || lstatSync(wrapperPath).isSymbolicLink()
    || !lstatSync(wrapperPath).isFile()
  ) {
    errors.push('PROJECT_RUNNER_WRAPPER_MISSING_OR_UNSAFE')
  } else {
    if (readFileSync(wrapperPath, 'utf8') !== governanceFile('templates/ci/check-delivery-policy.sh')) {
      errors.push('PROJECT_RUNNER_WRAPPER_DRIFTED')
    }
    if ((lstatSync(wrapperPath).mode & 0o777) !== 0o755) {
      errors.push('PROJECT_RUNNER_WRAPPER_MODE_DRIFTED')
    }
  }
  return errors
}

function taskArtifactErrors(projectRoot: string): string[] {
  const tasksRoot = join(projectRoot, '.delivery', 'tasks')
  if (!existsSync(tasksRoot)) return []
  if (lstatSync(tasksRoot).isSymbolicLink() || !lstatSync(tasksRoot).isDirectory()) {
    return ['TASK_ARTIFACT_ROOT_UNSAFE']
  }
  const errors: string[] = []
  for (const entry of readdirSync(tasksRoot, { withFileTypes: true }).sort((left, right) => (
    left.name.localeCompare(right.name)
  ))) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      errors.push(`TASK_ARTIFACT_DIRECTORY_UNSAFE:${entry.name}`)
      continue
    }
    const taskRoot = join(tasksRoot, entry.name)
    const contractPath = join(taskRoot, 'contract.yaml')
    if (!existsSync(contractPath)) {
      errors.push(`TASK_CONTRACT_MISSING:${entry.name}`)
      continue
    }
    try {
      const contract = parse(readFileSync(contractPath, 'utf8')) as Record<string, unknown>
      const schema = validateDocument('task-contract', contract)
      if (!schema.valid) {
        errors.push(...schema.errors.map((error) => `TASK_CONTRACT_INVALID:${entry.name}:${error}`))
      } else {
        const { contractDigest, ...unsigned } = contract
        if (canonicalDigest(unsigned) !== contractDigest) {
          errors.push(`TASK_CONTRACT_DIGEST_MISMATCH:${entry.name}`)
        }
        if (contract.taskId !== entry.name) errors.push(`TASK_DIRECTORY_ID_MISMATCH:${entry.name}`)
      }
    } catch {
      errors.push(`TASK_CONTRACT_INVALID:${entry.name}:UNREADABLE`)
    }

    const evidencePath = join(taskRoot, 'evidence.json')
    if (existsSync(evidencePath)) {
      try {
        const evidence = JSON.parse(readFileSync(evidencePath, 'utf8')) as unknown
        const schema = validateDocument('evidence', evidence)
        errors.push(...schema.errors.map((error) => `TASK_EVIDENCE_INVALID:${entry.name}:${error}`))
      } catch {
        errors.push(`TASK_EVIDENCE_INVALID:${entry.name}:UNREADABLE`)
      }
    }

    for (const reviewName of ['review.yaml', 'review.json']) {
      const reviewPath = join(taskRoot, reviewName)
      if (!existsSync(reviewPath)) continue
      try {
        const review = parse(readFileSync(reviewPath, 'utf8')) as unknown
        const schema = validateDocument('review', review)
        errors.push(...schema.errors.map((error) => `TASK_REVIEW_INVALID:${entry.name}:${error}`))
      } catch {
        errors.push(`TASK_REVIEW_INVALID:${entry.name}:UNREADABLE`)
      }
    }
  }
  return errors
}

export function planAdoption(projectPath: string, options: {
  runnerBundlePath?: string
} = {}): AdoptionPlan {
  const projectRoot = resolve(projectPath)
  const identity = governanceIdentity()
  const block = createManagedBlock(identity)
  const blockDigest = sha256(block)
  const profile = adoptionProfile(projectRoot)
  const runnerBundlePath = options.runnerBundlePath === undefined
    ? undefined
    : resolve(options.runnerBundlePath)
  let runner: { version: string; path: string; sha256: string } | undefined
  let runnerWrite: PlannedWrite | undefined
  let wrapperWrite: PlannedWrite | undefined
  if (runnerBundlePath !== undefined) {
    const expectedName = `engineering-governance-${identity.version}.tgz`
    if (
      !existsSync(runnerBundlePath)
      || lstatSync(runnerBundlePath).isSymbolicLink()
      || !lstatSync(runnerBundlePath).isFile()
    ) throw new Error('RUNNER_ARCHIVE_MISSING_OR_UNSAFE')
    if (basename(runnerBundlePath) !== expectedName) {
      throw new Error('RUNNER_ARCHIVE_VERSION_MISMATCH')
    }
    const bundle = readFileSync(runnerBundlePath)
    const runnerRelativePath = `.delivery/runtime/${expectedName}`
    runner = {
      version: identity.version,
      path: runnerRelativePath,
      sha256: sha256(bundle),
    }
    runnerWrite = planFileWrite(join(projectRoot, runnerRelativePath), bundle, 0o644)
    wrapperWrite = planFileWrite(
      join(projectRoot, '.delivery', 'bin', 'check-delivery-policy.sh'),
      governanceFile('templates/ci/check-delivery-policy.sh'),
      0o755,
    )
  }
  const policy = {
    schemaVersion: 1,
    sopVersion: identity.version,
    sopDigest: identity.digest,
    projectId: profile.projectId,
    adapters: profile.adapters.map((adapter) => ({ ...adapter, digest: blockDigest })),
    artifactMapping: {},
    ...(runner === undefined ? {} : { runner }),
  }
  const managedPaths = [
    '.delivery/policy.yaml',
    '.delivery/extensions.yaml',
    ...profile.adapters.map((adapter) => adapter.source),
    ...(runner === undefined ? [] : [
      runner.path,
      '.delivery/bin/check-delivery-policy.sh',
    ]),
  ]
  try {
    const overlap = validateManagedPathOverlap(discoverProject(projectRoot), managedPaths)
    if (!overlap.valid) throw new Error(overlap.errors.join('\n'))
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('DIRTY_MANAGED_PATH:')) throw error
  }
  const writes = [
    planFileWrite(join(projectRoot, '.delivery', 'policy.yaml'), stringify(policy)),
    planFileWrite(
      join(projectRoot, '.delivery', 'extensions.yaml'),
      stringify({ schemaVersion: 1, extensions: [] }),
    ),
    ...profile.adapters.map((adapter) => (
      planManagedBlockWrite(join(projectRoot, adapter.source), block)
    )),
    ...(runnerWrite === undefined ? [] : [runnerWrite]),
    ...(wrapperWrite === undefined ? [] : [wrapperWrite]),
  ]
  return { projectRoot, writes, digest: planDigest(projectRoot, writes) }
}

export function verifyAdoptedProject(projectPath: string): ValidationResult {
  const projectRoot = resolve(projectPath)
  const policyPath = join(projectRoot, '.delivery', 'policy.yaml')
  const errors: string[] = []
  if (!existsSync(policyPath)) return { valid: false, errors: ['PROJECT_POLICY_MISSING'] }

  let policy: unknown
  try {
    policy = parse(readFileSync(policyPath, 'utf8')) as unknown
  } catch {
    return { valid: false, errors: ['PROJECT_POLICY_INVALID:UNREADABLE'] }
  }
  const schema = validateProjectPolicy(policy)
  if (!schema.valid) errors.push(...schema.errors.map((error) => `PROJECT_POLICY_INVALID:${error}`))

  const identity = governanceIdentity()
  if (
    typeof policy !== 'object'
    || policy === null
    || (policy as Record<string, unknown>).sopVersion !== identity.version
    || (policy as Record<string, unknown>).sopDigest !== identity.digest
  ) {
    errors.push('PROJECT_POLICY_IDENTITY_MISMATCH')
  }
  errors.push(...validateExtensions(projectRoot))
  if (schema.valid) {
    const typedPolicy = policy as ProjectPolicy
    const expectedBlock = createManagedBlock(identity)
    errors.push(...adapterInventoryErrors(projectRoot, typedPolicy, expectedBlock))
    errors.push(...runnerErrors(projectRoot, typedPolicy, identity.version))
  }
  errors.push(...taskArtifactErrors(projectRoot))

  const uniqueErrors = [...new Set(errors)].sort()
  return { valid: uniqueErrors.length === 0, errors: uniqueErrors }
}
