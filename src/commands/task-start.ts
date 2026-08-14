import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'

import { stringify } from 'yaml'

import { canonicalDigest } from '../model/digest.js'
import { normalizeActorId } from '../model/actor.js'
import type { Risk } from '../model/types.js'
import { classifyRisk, type RiskSignals } from '../policy/risk.js'
import { initialTaskEvent } from '../state/ledger.js'
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
}

interface ObserverPolicyInput {
  expectedExitCode: number
  output: 'exact' | 'nonempty' | 'exit-only'
  checkoutMutation: 'forbidden'
  replay: 'required' | 'not-required' | 'prohibited'
}

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

interface IndependentSourcePolicy {
  mode: 'independent'
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
  sourcePolicy: IndependentSourcePolicy
  evidenceFreshnessMs?: number
  openChoices: string[]
  signals: RiskSignals
}

export type TaskStartInput = LegacyTaskStartInput | HardenedTaskStartInput

export interface TaskArtifact {
  path: string
  content: string
}

export interface TaskStartResult {
  risk: Risk
  state: 'DEFINED'
  artifacts: TaskArtifact[]
}

export function taskContractDigest(input: unknown): string {
  return canonicalDigest(input)
}

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex')
}

function hardenedTask(input: TaskStartInput): input is HardenedTaskStartInput {
  return input.schemaVersion === 2
}

function canonicalRepositories(
  repositories: HardenedTaskStartInput['repositories'],
): HardenedTaskStartInput['repositories'] {
  const ids = repositories.map((repository) => repository.id)
  if (new Set(ids).size !== ids.length) throw new Error('TASK_REPOSITORY_IDS_DUPLICATED')
  const canonical = repositories.map((repository) => ({
    id: repository.id,
    path: realpathSync(resolve(repository.path)),
  }))
  if (new Set(canonical.map((repository) => repository.path)).size !== canonical.length) {
    throw new Error('TASK_REPOSITORY_PATHS_DUPLICATED')
  }
  return canonical
}

function validateAcceptanceCommands(
  acceptance: HardenedAcceptanceInput[],
  repositories: HardenedTaskStartInput['repositories'],
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

export function startTask(input: TaskStartInput): TaskStartResult {
  const risk = classifyRisk(input.signals)
  if (!hardenedTask(input)) {
    if (risk === 'R0' || risk === 'R1') return { risk, state: 'DEFINED', artifacts: [] }

    const identity = governanceIdentity()
    const unsigned = {
      schemaVersion: 1,
      taskId: input.taskId,
      sopVersion: identity.version,
      risk,
      state: 'DEFINED',
      implementationOwner: input.implementationOwner,
      objective: input.objective,
      scope: input.scope,
      nonGoals: input.nonGoals,
      authorityInputs: input.authorityInputs,
      acceptance: input.acceptance,
      requiredGates: input.requiredGates,
      openChoices: input.openChoices,
    }
    const contract = { ...unsigned, contractDigest: taskContractDigest(unsigned) }
    return {
      risk,
      state: 'DEFINED',
      artifacts: [{
        path: `.delivery/tasks/${input.taskId}/contract.yaml`,
        content: stringify(contract),
      }],
    }
  }

  if (risk === 'R0') return { risk, state: 'DEFINED', artifacts: [] }
  const identity = governanceIdentity()
  const implementationOwner = normalizeActorId(input.implementationOwner)
  const repositories = canonicalRepositories(input.repositories)
  validateAcceptanceCommands(input.acceptance, repositories)
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
    acceptance: input.acceptance,
    evidenceFreshnessMs,
    authorizationRequirements: input.authorizationRequirements,
    sourcePolicy: input.sourcePolicy,
    openChoices: input.openChoices,
  }
  const contract = { ...unsigned, contractDigest: taskContractDigest(unsigned) }
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
