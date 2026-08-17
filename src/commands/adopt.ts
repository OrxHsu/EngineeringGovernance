import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { parse, stringify } from 'yaml'

import { canonicalDigest } from '../model/digest.js'
import type { ValidationResult } from '../model/types.js'
import { validateDocument, validateProjectPolicy } from '../policy/load.js'
import { adoptionProfile } from '../project/adoption-profile.js'
import { discoverProject, validateManagedPathOverlap } from '../project/discover.js'
import { createManagedBlock, planManagedBlockWrite } from '../project/managed-block.js'
import type { PlannedGuard, PlannedWrite } from '../project/mutate.js'
import { validateRunnerBundleIdentity } from '../project/runner-bundle.js'
import { MANAGED_BLOCK_END, MANAGED_BLOCK_START } from '../adapters/render.js'
import { loadProjectExtensions } from '../extensions/registry.js'

export interface AdoptionPlan {
  projectRoot: string
  writes: PlannedWrite[]
  generatedTargets: PlannedGuard[]
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
    generatedTargets: plan.generatedTargets,
  }
}

function sha256(input: string | Uint8Array): string {
  return createHash('sha256').update(input).digest('hex')
}

function governanceFile(path: string): string {
  return readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')
}

const governanceSourceFiles = [
  'CORE_INVARIANTS.md',
  'DEVELOPMENT_SOP.md',
  'MIGRATING_TO_2.0.md',
  'RISK_CLASSIFICATION.md',
  'LICENSE',
  'NOTICE',
  'SECURITY.md',
  'CHANGELOG.md',
  'VERSION',
  'package.json',
  'scripts/build-runner-bundle.mjs',
]

const governanceSourceDirectories = [
  'adapters',
  'dist',
  'schemas',
  'skills/delivery-sop',
  'src',
  'templates',
]

function governanceRoot(): string {
  return realpathSync(fileURLToPath(new URL('../../', import.meta.url)))
}

function recursiveFiles(root: string, relativeDirectory: string): string[] {
  const directory = join(root, relativeDirectory)
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const relativePath = join(relativeDirectory, entry.name)
    if (entry.name.startsWith('.') || entry.isSymbolicLink()) return []
    if (entry.isDirectory()) return recursiveFiles(root, relativePath)
    return entry.isFile() ? [relativePath] : []
  })
}

interface IdentitySourceLocation {
  path: string
  sourcePath: string
}

function recursiveDependencyFiles(sourceRoot: string, targetRoot: string): IdentitySourceLocation[] {
  return readdirSync(sourceRoot, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.isSymbolicLink()) return []
    const sourcePath = join(sourceRoot, entry.name)
    const targetPath = join(targetRoot, entry.name)
    if (entry.isDirectory()) return recursiveDependencyFiles(sourcePath, targetPath)
    return entry.isFile() ? [{ path: targetPath, sourcePath }] : []
  })
}

function runtimeDependencySources(
  sourcePackageInput: string,
  targetPackage: string,
  ancestry = new Set<string>(),
): IdentitySourceLocation[] {
  const sourcePackage = realpathSync(sourcePackageInput)
  const metadata = JSON.parse(readFileSync(join(sourcePackage, 'package.json'), 'utf8')) as {
    name: string
    dependencies?: Record<string, string>
  }
  const nextAncestry = new Set(ancestry).add(metadata.name)
  const nested = Object.keys(metadata.dependencies ?? {}).sort().flatMap((dependency) => (
    nextAncestry.has(dependency)
      ? []
      : runtimeDependencySources(
        existsSync(join(sourcePackage, 'node_modules', dependency))
          ? join(sourcePackage, 'node_modules', dependency)
          : join(dirname(sourcePackage), dependency),
        join(targetPackage, 'node_modules', dependency),
        nextAncestry,
      )
  ))
  return [...recursiveDependencyFiles(sourcePackage, targetPackage), ...nested]
}

export function governanceIdentitySources(): Array<{ path: string; sha256: string }> {
  const root = governanceRoot()
  const governanceSources = [
    ...governanceSourceFiles,
    ...governanceSourceDirectories.flatMap((directory) => recursiveFiles(root, directory)),
  ].map((path): IdentitySourceLocation => ({ path, sourcePath: join(root, path) }))
  return governanceSources
    .sort((left, right) => left.path.localeCompare(right.path))
    .map((source) => ({ path: source.path, sha256: sha256(readFileSync(source.sourcePath)) }))
}

function runnerDependencyIdentitySources(): Array<{ path: string; sha256: string }> {
  const root = governanceRoot()
  return ['ajv', 'commander', 'yaml'].flatMap((dependency) => (
    runtimeDependencySources(
      join(root, 'node_modules', dependency),
      join('node_modules', dependency),
    )
  ))
    .sort((left, right) => left.path.localeCompare(right.path))
    .map((source) => ({ path: source.path, sha256: sha256(readFileSync(source.sourcePath)) }))
}

export function governanceIdentity(): { version: string; digest: string } {
  const version = governanceFile('VERSION').trim()
  const digest = canonicalDigest(governanceIdentitySources())
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

function planDigest(
  projectRoot: string,
  writes: PlannedWrite[],
  generatedTargets: PlannedGuard[],
): string {
  return sha256(JSON.stringify({
    projectRoot,
    writes: writes.map((write) => ({
      path: write.path,
      beforeDigest: write.beforeDigest,
      afterDigest: sha256(write.after),
      mode: write.mode,
    })),
    generatedTargets,
  }))
}

function targetGuard(path: string): PlannedGuard {
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
    throw new Error(`MANAGED_PATH_IS_SYMLINK:${path}`)
  }
  return {
    path,
    beforeDigest: existsSync(path) ? sha256(readFileSync(path)) : null,
  }
}

function repositoryRootForTarget(path: string): string {
  const probe = existsSync(path) && lstatSync(path).isDirectory() ? path : dirname(path)
  try {
    return execFileSync('git', ['-C', probe, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
  } catch {
    throw new Error(`GENERATED_TARGET_REPOSITORY_UNAVAILABLE:${path}`)
  }
}

function canonicalTargetPath(path: string): string {
  return existsSync(path)
    ? realpathSync(path)
    : join(realpathSync(dirname(path)), basename(path))
}

function dirtyRepositoryPaths(repositoryRoot: string): string[] {
  return execFileSync(
    'git',
    ['-C', repositoryRoot, 'status', '--porcelain=v1', '-z'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  )
    .split('\0')
    .filter(Boolean)
    .map((entry) => entry.slice(3))
}

function expectedManagedDirtyPaths(
  projectRoot: string,
  policy: ProjectPolicy | undefined,
  errors: string[],
): string[] {
  if (policy === undefined) return errors
  return errors.filter((error) => {
    const relativePath = error.slice('DIRTY_MANAGED_PATH:'.length)
    const path = join(projectRoot, relativePath)
    if (relativePath === 'AGENTS.md') {
      const text = readFileSync(path, 'utf8')
      return !text.includes(`Governance version: \`${policy.sopVersion}\``)
        || !text.includes(`Governance digest: \`${policy.sopDigest}\``)
    }
    if (relativePath === '.delivery/policy.yaml') {
      return false
    }
    if (relativePath === '.delivery/bin/check-delivery-policy.sh') {
      return readFileSync(path, 'utf8') !== governanceFile('templates/ci/check-delivery-policy.sh')
    }
    if (policy.runner?.path === relativePath) {
      return sha256(readFileSync(path)) !== policy.runner.sha256
    }
    return true
  })
}

function generatedTargetOverlapErrors(projectRoot: string, targets: PlannedGuard[]): string[] {
  return targets.flatMap((target) => {
    const repositoryRoot = repositoryRootForTarget(target.path)
    const repositoryPath = relative(realpathSync(repositoryRoot), canonicalTargetPath(target.path))
    return dirtyRepositoryPaths(repositoryRoot).includes(repositoryPath)
      ? [`DIRTY_MANAGED_PATH:${relative(projectRoot, target.path)}`]
      : []
  }).sort()
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
  try {
    loadProjectExtensions(projectRoot)
    return []
  } catch {
    return ['PROJECT_EXTENSIONS_INVALID']
  }
}

function plannedExtensionsContent(projectRoot: string): string {
  const path = join(projectRoot, '.delivery', 'extensions.yaml')
  if (!existsSync(path)) return stringify({ schemaVersion: 2, extensions: [] })
  if (lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile()) {
    throw new Error('PROJECT_EXTENSIONS_MISSING_OR_UNSAFE')
  }
  const raw = readFileSync(path, 'utf8')
  const document = parse(raw) as { schemaVersion?: number; extensions?: unknown[] }
  if (document.schemaVersion === 1) {
    if (!Array.isArray(document.extensions) || document.extensions.length > 0) {
      throw new Error('PROJECT_EXTENSIONS_MIGRATION_REQUIRED')
    }
    return stringify({ schemaVersion: 2, extensions: [] })
  }
  loadProjectExtensions(projectRoot)
  return raw
}

function plannedArtifactMapping(projectRoot: string, currentPolicyDigest: string): Record<string, string> {
  const path = join(projectRoot, '.delivery', 'policy.yaml')
  if (!existsSync(path)) return {}
  if (lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile()) {
    throw new Error('PROJECT_POLICY_MISSING_OR_UNSAFE')
  }
  const document = parse(readFileSync(path, 'utf8')) as { artifactMapping?: unknown; sopDigest?: unknown }
  const mapping = document.artifactMapping
  const mappingRecord = mapping as Record<string, unknown>
  if (
    typeof mapping !== 'object'
    || mapping === null
    || Array.isArray(mapping)
    || Object.values(mappingRecord).some((value) => typeof value !== 'string' || value.length === 0)
  ) throw new Error('PROJECT_ARTIFACT_MAPPING_INVALID')
  const historicalPolicyDigests: string[] = [
    ...(typeof document.sopDigest === 'string' ? [document.sopDigest] : []),
    ...['.delivery/accountability/actors.jsonl', '.delivery/accountability/events.jsonl']
      .flatMap((relativePath) => {
        const evidencePath = join(projectRoot, relativePath)
        if (!existsSync(evidencePath) || lstatSync(evidencePath).isSymbolicLink()) return []
        return readFileSync(evidencePath, 'utf8')
          .split('\n')
          .filter(Boolean)
          .flatMap((line) => {
            try {
              const value = JSON.parse(line) as { policyDigest?: unknown }
              return typeof value.policyDigest === 'string' ? [value.policyDigest] : []
            } catch {
              return []
            }
          })
      }),
  ].filter((value): value is string => /^[a-f0-9]{64}$/u.test(value) && value !== currentPolicyDigest)
  const existingLineageValue = mappingRecord['accountability.policyLineage']
  const existingLineage = typeof existingLineageValue === 'string'
    ? existingLineageValue.split(',').map((value) => value.trim())
    : []
  const policyLineage = [...new Set([...existingLineage, ...historicalPolicyDigests])]
    .filter((value) => /^[a-f0-9]{64}$/u.test(value) && value !== currentPolicyDigest)
    .sort()
  const nextMapping = Object.fromEntries(
    Object.entries(mappingRecord).map(([key, value]) => [key, value as string]),
  )
  if (policyLineage.length > 0) nextMapping['accountability.policyLineage'] = policyLineage.join(',')
  return Object.fromEntries(
    Object.entries(nextMapping)
      .sort(([left], [right]) => left.localeCompare(right)),
  )
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

    const taskEntries = readdirSync(taskRoot, { withFileTypes: true })
    for (const artifact of taskEntries.filter((candidate) => candidate.isSymbolicLink())) {
      errors.push(`TASK_ARTIFACT_PATH_UNSAFE:${entry.name}:${artifact.name}`)
    }
    const artifactFiles = taskEntries
      .filter((artifact) => artifact.isFile() && !artifact.isSymbolicLink())
      .map((artifact) => artifact.name)
      .sort()
    for (const evidenceName of artifactFiles.filter((name) => /^evidence(?:-.+)?\.json$/u.test(name))) {
      const evidencePath = join(taskRoot, evidenceName)
      try {
        const evidence = JSON.parse(readFileSync(evidencePath, 'utf8')) as unknown
        const schema = validateDocument('evidence', evidence)
        errors.push(...schema.errors.map((error) => (
          `TASK_EVIDENCE_INVALID:${entry.name}:${evidenceName}:${error}`
        )))
      } catch {
        errors.push(`TASK_EVIDENCE_INVALID:${entry.name}:${evidenceName}:UNREADABLE`)
      }
    }

    for (const candidateName of artifactFiles.filter((name) => /^candidate(?:-.+)?\.(?:yaml|json)$/u.test(name))) {
      const candidatePath = join(taskRoot, candidateName)
      try {
        const candidate = parse(readFileSync(candidatePath, 'utf8')) as unknown
        const schema = validateDocument('candidate', candidate)
        errors.push(...schema.errors.map((error) => (
          `TASK_CANDIDATE_INVALID:${entry.name}:${candidateName}:${error}`
        )))
      } catch {
        errors.push(`TASK_CANDIDATE_INVALID:${entry.name}:${candidateName}:UNREADABLE`)
      }
    }

    for (const reviewName of artifactFiles.filter((name) => /^review(?:-.+)?\.(?:yaml|json)$/u.test(name))) {
      const reviewPath = join(taskRoot, reviewName)
      try {
        const review = parse(readFileSync(reviewPath, 'utf8')) as unknown
        const schema = validateDocument('review', review)
        errors.push(...schema.errors.map((error) => (
          `TASK_REVIEW_INVALID:${entry.name}:${reviewName}:${error}`
        )))
      } catch {
        errors.push(`TASK_REVIEW_INVALID:${entry.name}:${reviewName}:UNREADABLE`)
      }
    }

    for (const closureName of artifactFiles.filter((name) => /^closure(?:-.+)?\.(?:yaml|json)$/u.test(name))) {
      const closurePath = join(taskRoot, closureName)
      try {
        const closure = parse(readFileSync(closurePath, 'utf8')) as unknown
        const schema = validateDocument('closure', closure)
        errors.push(...schema.errors.map((error) => (
          `TASK_CLOSURE_INVALID:${entry.name}:${closureName}:${error}`
        )))
      } catch {
        errors.push(`TASK_CLOSURE_INVALID:${entry.name}:${closureName}:UNREADABLE`)
      }
    }
  }
  return errors
}

export function planAdoption(projectPath: string, options: {
  runnerBundlePath?: string
  allowExpectedManagedDirty?: boolean
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
    validateRunnerBundleIdentity({
      archivePath: runnerBundlePath,
      expectedVersion: identity.version,
      identitySources: governanceIdentitySources(),
      dependencySources: runnerDependencyIdentitySources(),
    })
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
    artifactMapping: plannedArtifactMapping(projectRoot, identity.digest),
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
  const generatedTargets = profile.adapters.flatMap((adapter) => (
    adapter.targets
      .filter((target) => target !== adapter.source)
      .map((target) => targetGuard(join(projectRoot, target)))
  ))
  try {
    const overlap = validateManagedPathOverlap(discoverProject(projectRoot), managedPaths)
    if (!overlap.valid) {
      const currentPolicyPath = join(projectRoot, '.delivery', 'policy.yaml')
      let currentPolicy: ProjectPolicy | undefined
      if (existsSync(currentPolicyPath)) {
        try { currentPolicy = parse(readFileSync(currentPolicyPath, 'utf8')) as ProjectPolicy } catch { currentPolicy = undefined }
      }
      const errors = options.allowExpectedManagedDirty
        ? expectedManagedDirtyPaths(projectRoot, currentPolicy, overlap.errors)
        : overlap.errors
      if (errors.length > 0) throw new Error(errors.join('\n'))
    }
  } catch (error) {
    if (!(error instanceof Error) || error.message.startsWith('DIRTY_MANAGED_PATH:')) throw error
  }
  const generatedTargetErrors = generatedTargetOverlapErrors(projectRoot, generatedTargets)
  if (generatedTargetErrors.length > 0) throw new Error(generatedTargetErrors.join('\n'))
  const writes = [
    planFileWrite(join(projectRoot, '.delivery', 'policy.yaml'), stringify(policy)),
    planFileWrite(
      join(projectRoot, '.delivery', 'extensions.yaml'),
      plannedExtensionsContent(projectRoot),
    ),
    ...profile.adapters.map((adapter) => (
      planManagedBlockWrite(join(projectRoot, adapter.source), block)
    )),
    ...(runnerWrite === undefined ? [] : [runnerWrite]),
    ...(wrapperWrite === undefined ? [] : [wrapperWrite]),
  ]
  return {
    projectRoot,
    writes,
    generatedTargets,
    digest: planDigest(projectRoot, writes, generatedTargets),
  }
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
