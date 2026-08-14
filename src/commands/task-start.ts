import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

import { stringify } from 'yaml'

import { canonicalDigest } from '../model/digest.js'
import { normalizeActorId } from '../model/actor.js'
import type { Risk } from '../model/types.js'
import { classifyRisk, highestRisk, type RiskSignals } from '../policy/risk.js'
import { validateHardenedTaskContract } from '../policy/task-contract.js'
import { initialTaskEvent } from '../state/ledger.js'
import { captureCheckoutSnapshot } from '../evidence/checkout-snapshot.js'
import type { ExtensionDescriptor } from '../extensions/registry.js'
import {
  externalSourceExtensionId,
  externalSourceExtensionVersion,
  externalSourceMinimumRisk,
  validateExternalSourceTaskInput,
} from '../extensions/external-source.js'
import { governanceIdentity } from './adopt.js'

interface LegacyAcceptanceInput {
  id: string
  observation: string
  positiveCases: string[]
  negativeCases: string[]
}

interface ContractCommandInput {
  repositoryId: string
  cwd: string
  executable: string
  arguments: string[]
  environment?: Record<string, string>
}

interface ObserverPolicyBase {
  expectedExitCode: number
  checkoutMutation: 'forbidden'
  replay: 'required' | 'not-required' | 'prohibited'
}

type ObserverPolicyInput = ObserverPolicyBase & ({
  output: 'exact'
  expectedStdoutSha256: string
  expectedStderrSha256: string
} | {
  output: 'nonempty' | 'exit-only'
})

interface HardenedAcceptanceInput extends LegacyAcceptanceInput {
  evidenceKind: 'static' | 'compile' | 'unit' | 'integration' | 'device' | 'cloud' | 'production'
  command: ContractCommandInput
  observerPolicy: ObserverPolicyInput
}

interface AuthorizationRequirementInput {
  id: string
  action: string
  target: string
  scope: string[]
  trustLevel: 'recorded-claim' | 'verified-attestation'
  consumeOnce: boolean
}

export interface LegacyTaskStartInput {
  schemaVersion?: 1
  taskId: string
  implementationOwner: string
  objective: string
  scope: string[]
  nonGoals: string[]
  authorityInputs: string[]
  acceptance: LegacyAcceptanceInput[]
  requiredGates: string[]
  openChoices: string[]
  signals: RiskSignals
}

export interface HardenedTaskStartInput {
  schemaVersion: 2
  taskId: string
  implementationOwner: string
  objective: string
  scope: string[]
  nonGoals: string[]
  authorityInputs: string[]
  repositories: Array<{ id: string; path: string }>
  acceptance: HardenedAcceptanceInput[]
  authorizationRequirements: AuthorizationRequirementInput[]
  evidenceFreshnessMs?: number
  extensionInputs?: Record<string, unknown>
  openChoices: string[]
  signals: RiskSignals
}

export type TaskStartInput = HardenedTaskStartInput

export interface TaskStartContext {
  projectExtensions?: ExtensionDescriptor[]
}

export interface TaskArtifact {
  path: string
  content: string
}

export interface TaskStartResult {
  risk: Risk
  state: 'DEFINED'
  artifacts: TaskArtifact[]
}

export interface TaskStartPlan extends TaskStartResult {
  schemaVersion: 2
  artifactType: 'sop-task-start-plan-v2'
  projectRoot: string
  taskId: string
  digest: string
}

const taskIdPattern = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/u
const riskSignalKeys = new Set<keyof RiskSignals>([
  'readOnly',
  'localEdit',
  'mutation',
  'classificationComplete',
  'userVisible',
  'crossModule',
  'multiRepository',
  'persistentData',
  'authentication',
  'authorization',
  'privacy',
  'security',
  'migration',
  'destructive',
  'payments',
  'production',
  'deployment',
  'remoteMutation',
  'externalCommunication',
  'restrictedRuntime',
  'projectMinimum',
])
const evidenceKinds = new Set<HardenedAcceptanceInput['evidenceKind']>([
  'static',
  'compile',
  'unit',
  'integration',
  'device',
  'cloud',
  'production',
])

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, required: string[], optional: string[] = []): boolean {
  const keys = Object.keys(value)
  const allowed = new Set([...required, ...optional])
  return required.every((key) => Object.hasOwn(value, key))
    && keys.every((key) => allowed.has(key))
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function uniqueStringArray(value: unknown, minimum: number): value is string[] {
  return Array.isArray(value)
    && value.length >= minimum
    && value.every((item) => nonEmptyString(item))
    && new Set(value).size === value.length
}

function stringArray(value: unknown, minimum: number): value is string[] {
  return Array.isArray(value)
    && value.length >= minimum
    && value.every((item) => nonEmptyString(item))
}

function validHash(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)
}

function validRiskSignals(value: unknown): value is RiskSignals {
  if (!record(value) || Object.keys(value).length === 0) return false
  for (const [key, signal] of Object.entries(value)) {
    if (!riskSignalKeys.has(key as keyof RiskSignals)) return false
    if (key === 'projectMinimum') {
      if (signal !== 'R0' && signal !== 'R1' && signal !== 'R2' && signal !== 'R3') return false
    } else if (typeof signal !== 'boolean') {
      return false
    }
  }
  return true
}

function validCommand(value: unknown): boolean {
  if (!record(value) || !exactKeys(value, ['repositoryId', 'cwd', 'executable', 'arguments'], ['environment'])) {
    return false
  }
  if (!nonEmptyString(value.repositoryId)
    || !taskIdPattern.test(value.repositoryId)
    || !nonEmptyString(value.cwd)
    || !nonEmptyString(value.executable)) {
    return false
  }
  if (!Array.isArray(value.arguments) || !value.arguments.every((argument) => typeof argument === 'string')) {
    return false
  }
  if (Object.hasOwn(value, 'environment')) {
    if (!record(value.environment)) return false
    for (const [key, environmentValue] of Object.entries(value.environment)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) || typeof environmentValue !== 'string' || environmentValue.includes('\0')) {
        return false
      }
    }
  }
  return true
}

function validObserverPolicy(value: unknown): boolean {
  if (!record(value) || !nonEmptyString(value.output)) return false
  const baseKeys = ['expectedExitCode', 'output', 'checkoutMutation', 'replay']
  const exactKeysForOutput = value.output === 'exact'
    ? [...baseKeys, 'expectedStdoutSha256', 'expectedStderrSha256']
    : baseKeys
  if (!exactKeys(value, baseKeys, value.output === 'exact'
    ? ['expectedStdoutSha256', 'expectedStderrSha256']
    : [])) return false
  if (!Number.isInteger(value.expectedExitCode)
    || value.checkoutMutation !== 'forbidden'
    || (value.replay !== 'required' && value.replay !== 'not-required' && value.replay !== 'prohibited')) {
    return false
  }
  if (value.output !== 'exact' && value.output !== 'nonempty' && value.output !== 'exit-only') return false
  if (value.output === 'exact') {
    return exactKeys(value, exactKeysForOutput)
      && validHash(value.expectedStdoutSha256)
      && validHash(value.expectedStderrSha256)
  }
  return true
}

function validAcceptance(value: unknown): boolean {
  if (!record(value) || !exactKeys(value, [
    'id',
    'observation',
    'positiveCases',
    'negativeCases',
    'evidenceKind',
    'command',
    'observerPolicy',
  ])) return false
  return nonEmptyString(value.id)
    && nonEmptyString(value.observation)
    && stringArray(value.positiveCases, 1)
    && stringArray(value.negativeCases, 1)
    && typeof value.evidenceKind === 'string'
    && evidenceKinds.has(value.evidenceKind as HardenedAcceptanceInput['evidenceKind'])
    && validCommand(value.command)
    && validObserverPolicy(value.observerPolicy)
}

function validAuthorizationRequirement(value: unknown): boolean {
  if (!record(value) || !exactKeys(value, [
    'id',
    'action',
    'target',
    'scope',
    'trustLevel',
    'consumeOnce',
  ])) return false
  return nonEmptyString(value.id)
    && nonEmptyString(value.action)
    && nonEmptyString(value.target)
    && uniqueStringArray(value.scope, 1)
    && (value.trustLevel === 'recorded-claim' || value.trustLevel === 'verified-attestation')
    && typeof value.consumeOnce === 'boolean'
}

function validateHardenedTaskStartInput(input: unknown): asserts input is TaskStartInput {
  if (!record(input) || input.schemaVersion !== 2) {
    throw new Error('ACTIVE_COMMAND_REQUIRES_SCHEMA_VERSION_2')
  }
  const evidenceFreshnessMs = input.evidenceFreshnessMs
  if (!exactKeys(input, [
    'schemaVersion',
    'taskId',
    'implementationOwner',
    'objective',
    'scope',
    'nonGoals',
    'authorityInputs',
    'repositories',
    'acceptance',
    'authorizationRequirements',
    'openChoices',
    'signals',
  ], ['evidenceFreshnessMs', 'extensionInputs'])
    || typeof input.taskId !== 'string'
    || !taskIdPattern.test(input.taskId)
    || !nonEmptyString(input.implementationOwner)
    || !nonEmptyString(input.objective)
    || !uniqueStringArray(input.scope, 1)
    || !uniqueStringArray(input.nonGoals, 0)
    || !uniqueStringArray(input.authorityInputs, 1)
    || !Array.isArray(input.repositories)
    || input.repositories.length === 0
    || input.repositories.some((repository) => (
      !record(repository)
      || !exactKeys(repository, ['id', 'path'])
      || typeof repository.id !== 'string'
      || !taskIdPattern.test(repository.id)
      || !nonEmptyString(repository.path)
    ))
    || !Array.isArray(input.acceptance)
    || input.acceptance.length === 0
    || input.acceptance.some((acceptance) => !validAcceptance(acceptance))
    || !Array.isArray(input.authorizationRequirements)
    || input.authorizationRequirements.some((requirement) => !validAuthorizationRequirement(requirement))
    || !uniqueStringArray(input.openChoices, 0)
    || !validRiskSignals(input.signals)
    || (Object.hasOwn(input, 'evidenceFreshnessMs')
      && (typeof evidenceFreshnessMs !== 'number'
        || !Number.isInteger(evidenceFreshnessMs)
        || evidenceFreshnessMs < 1
        || evidenceFreshnessMs > 86_400_000))
    || (Object.hasOwn(input, 'extensionInputs')
      && input.extensionInputs !== undefined
      && !record(input.extensionInputs))) {
    throw new Error('TASK_START_INPUT_INVALID')
  }
}

export function taskContractDigest(input: unknown): string {
  return canonicalDigest(input)
}

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex')
}

function sha256Bytes(input: Uint8Array): string {
  return createHash('sha256').update(input).digest('hex')
}

function resolvedExecutable(input: string): { path: string; sha256: string } {
  if (input.trim().length === 0) throw new Error('TASK_GATE_EXECUTABLE_REQUIRED')
  let unresolved = input
  if (!isAbsolute(unresolved)) {
    try {
      unresolved = execFileSync('/usr/bin/which', [unresolved], {
        encoding: 'utf8',
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin' },
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim()
    } catch {
      throw new Error(`TASK_GATE_EXECUTABLE_NOT_FOUND:${input}`)
    }
  }
  const path = realpathSync(resolve(unresolved))
  if (!lstatSync(path).isFile()) throw new Error(`TASK_GATE_EXECUTABLE_UNSAFE:${input}`)
  return { path, sha256: sha256Bytes(readFileSync(path)) }
}

function frozenEnvironment(input?: Record<string, string>): Record<string, string> {
  const environment = input ?? {
    PATH: `${dirname(realpathSync(process.execPath))}:/usr/bin:/bin:/usr/sbin:/sbin`,
  }
  for (const [key, value] of Object.entries(environment)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) || typeof value !== 'string' || value.includes('\0')) {
      throw new Error(`TASK_GATE_ENVIRONMENT_INVALID:${key}`)
    }
  }
  return Object.fromEntries(Object.entries(environment).sort(([left], [right]) => left.localeCompare(right)))
}

function canonicalRepositories(
  repositories: HardenedTaskStartInput['repositories'],
): Array<{
  id: string
  path: string
  baseline: {
    head: string
    tree: string
    checkoutDigest: string
    trackedPaths: string[]
    untrackedPaths: string[]
  }
}> {
  const ids = repositories.map((repository) => repository.id)
  if (new Set(ids).size !== ids.length) throw new Error('TASK_REPOSITORY_IDS_DUPLICATED')
  const canonical = repositories.map((repository) => {
    const path = realpathSync(resolve(repository.path))
    const snapshot = captureCheckoutSnapshot({ id: repository.id, path })
    return {
      id: repository.id,
      path,
      baseline: {
        head: snapshot.head,
        tree: snapshot.tree,
        checkoutDigest: canonicalDigest(snapshot),
        trackedPaths: snapshot.trackedPaths,
        untrackedPaths: snapshot.untracked.map((item) => item.path),
      },
    }
  })
  if (new Set(canonical.map((repository) => repository.path)).size !== canonical.length) {
    throw new Error('TASK_REPOSITORY_PATHS_DUPLICATED')
  }
  return canonical
}

function validateAcceptanceCommands(
  acceptance: HardenedAcceptanceInput[],
  repositories: Array<{ id: string; path: string }>,
): void {
  const acceptanceIds = acceptance.map((item) => item.id)
  if (new Set(acceptanceIds).size !== acceptanceIds.length) {
    throw new Error('TASK_ACCEPTANCE_IDS_DUPLICATED')
  }
  const repositoryById = new Map(repositories.map((repository) => [repository.id, repository.path]))
  for (const item of acceptance) {
    const repository = repositoryById.get(item.command.repositoryId)
    if (repository === undefined) {
      throw new Error(`TASK_GATE_REPOSITORY_UNKNOWN:${item.id}`)
    }
    if (isAbsolute(item.command.cwd)) {
      throw new Error(`TASK_GATE_CWD_MUST_BE_RELATIVE:${item.id}`)
    }
    const cwd = resolve(repository, item.command.cwd)
    const relativePath = relative(repository, cwd)
    if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
      throw new Error(`TASK_GATE_CWD_OUTSIDE_REPOSITORY:${item.id}`)
    }
  }
}

export function startTask(input: TaskStartInput, context: TaskStartContext = {}): TaskStartResult {
  validateHardenedTaskStartInput(input)
  let risk = classifyRisk(input.signals)
  if (risk === 'R0') return { risk, state: 'DEFINED', artifacts: [] }
  const identity = governanceIdentity()
  const implementationOwner = normalizeActorId(input.implementationOwner)
  const repositories = canonicalRepositories(input.repositories)
  validateAcceptanceCommands(input.acceptance, repositories)
  const acceptance = input.acceptance.map((gate) => {
    const executable = resolvedExecutable(gate.command.executable)
    return {
      ...gate,
      command: {
        ...gate.command,
        executable: executable.path,
        executableSha256: executable.sha256,
        environment: frozenEnvironment(gate.command.environment),
      },
    }
  })
  const projectExtensions = context.projectExtensions ?? []
  const extensionKeys = projectExtensions.map((extension) => `${extension.id}@${extension.version}`)
  if (new Set(extensionKeys).size !== extensionKeys.length) throw new Error('TASK_EXTENSIONS_DUPLICATED')
  const providedInputs = input.extensionInputs ?? {}
  for (const key of Object.keys(providedInputs)) {
    if (!extensionKeys.includes(key)) throw new Error(`TASK_EXTENSION_INPUT_UNBOUND:${key}`)
  }
  const extensions = projectExtensions.map((extension) => {
    const key = `${extension.id}@${extension.version}`
    let extensionInput = providedInputs[key]
    if (extension.id === externalSourceExtensionId && extension.version === externalSourceExtensionVersion) {
      const validatedInput = validateExternalSourceTaskInput(extensionInput ?? { mode: 'independent' })
      extensionInput = validatedInput
      const minimum = externalSourceMinimumRisk(validatedInput)
      if (minimum !== undefined) risk = highestRisk([risk, minimum])
    } else if (extensionInput === undefined) {
      extensionInput = {}
    }
    return { id: extension.id, version: extension.version, digest: extension.digest, input: extensionInput }
  })
  const evidenceFreshnessMs = input.evidenceFreshnessMs ?? 86_400_000
  if (!Number.isInteger(evidenceFreshnessMs) || evidenceFreshnessMs < 1 || evidenceFreshnessMs > 86_400_000) {
    throw new Error('TASK_EVIDENCE_FRESHNESS_INVALID')
  }
  const contractPath = `.delivery/tasks/${input.taskId}/contract.yaml`
  const unsigned = {
    schemaVersion: 2,
    taskId: input.taskId,
    sopVersion: identity.version,
    policyDigest: identity.digest,
    risk,
    riskSignals: input.signals,
    implementationOwner,
    objective: input.objective,
    scope: input.scope,
    nonGoals: input.nonGoals,
    authorityInputs: input.authorityInputs,
    repositories,
    acceptance,
    evidenceFreshnessMs,
    authorizationRequirements: input.authorizationRequirements,
    extensions,
    openChoices: input.openChoices,
  }
  const contract = { ...unsigned, contractDigest: taskContractDigest(unsigned) }
  const semantic = validateHardenedTaskContract(contract)
  if (!semantic.valid) throw new Error(semantic.errors.join(','))
  const contractContent = stringify(contract)
  const event = initialTaskEvent({
    actorId: implementationOwner,
    contractDigest: contract.contractDigest,
    contractPath,
    contractSha256: sha256(contractContent),
  })
  return {
    risk,
    state: 'DEFINED',
    artifacts: [
      { path: contractPath, content: contractContent },
      {
        path: `.delivery/tasks/${input.taskId}/ledger.jsonl`,
        content: `${JSON.stringify(event)}\n`,
      },
    ],
  }
}

export function planTaskStart(
  projectPath: string,
  input: TaskStartInput,
  context: TaskStartContext = {},
): TaskStartPlan {
  const projectRoot = realpathSync(resolve(projectPath))
  const result = startTask(input, context)
  const unsigned = {
    schemaVersion: 2 as const,
    artifactType: 'sop-task-start-plan-v2' as const,
    projectRoot,
    taskId: input.taskId,
    ...result,
    artifacts: result.artifacts.map((artifact) => ({
      path: join(projectRoot, artifact.path),
      content: artifact.content,
    })),
  }
  return { ...unsigned, digest: canonicalDigest(unsigned) }
}

function assertSafeTaskTarget(projectRoot: string, path: string): void {
  const relativePath = relative(projectRoot, path)
  if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
    throw new Error(`TASK_START_TARGET_OUTSIDE_PROJECT:${path}`)
  }
  let current = projectRoot
  for (const segment of relativePath.split('/').slice(0, -1)) {
    current = join(current, segment)
    if (existsSync(current) && (lstatSync(current).isSymbolicLink() || !lstatSync(current).isDirectory())) {
      throw new Error(`TASK_START_TARGET_PARENT_UNSAFE:${current}`)
    }
  }
  if (existsSync(path)) throw new Error(`TASK_START_TARGET_EXISTS:${path}`)
}

export function applyTaskStart(
  plan: TaskStartPlan,
  reviewedDigest: string,
): { applied: string[] } {
  const { digest, ...unsigned } = plan
  if (reviewedDigest !== digest || canonicalDigest(unsigned) !== digest) {
    throw new Error('TASK_START_PLAN_DIGEST_MISMATCH')
  }
  for (const artifact of plan.artifacts) assertSafeTaskTarget(plan.projectRoot, artifact.path)
  const applied: string[] = []
  try {
    for (const artifact of plan.artifacts) {
      mkdirSync(dirname(artifact.path), { recursive: true })
      writeFileSync(artifact.path, artifact.content, { flag: 'wx', mode: 0o644 })
      applied.push(artifact.path)
    }
  } catch (error) {
    for (const path of applied.reverse()) unlinkSync(path)
    throw error
  }
  return { applied }
}
