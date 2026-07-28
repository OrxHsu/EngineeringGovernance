import { createHash } from 'node:crypto'

import { stringify } from 'yaml'

import type { Risk } from '../model/types.js'
import { classifyRisk, type RiskSignals } from '../policy/risk.js'
import { governanceIdentity } from './adopt.js'

interface AcceptanceInput {
  id: string
  observation: string
  positiveCases: string[]
  negativeCases: string[]
}

export interface TaskStartInput {
  taskId: string
  implementationOwner: string
  objective: string
  scope: string[]
  nonGoals: string[]
  authorityInputs: string[]
  acceptance: AcceptanceInput[]
  requiredGates: string[]
  openChoices: string[]
  signals: RiskSignals
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

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (typeof value !== 'object' || value === null) return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonical(entry)]),
  )
}

export function taskContractDigest(input: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonical(input))).digest('hex')
}

export function startTask(input: TaskStartInput): TaskStartResult {
  const risk = classifyRisk(input.signals)
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
