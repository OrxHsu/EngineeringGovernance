import type { TaskState } from '../model/types.js'
import {
  applyTaskTransition,
  planTaskTransition,
  type TaskTransitionPlan,
} from '../state/ledger.js'

const ownerTargets = new Set<TaskState>([
  'IN_PROGRESS',
  'CANDIDATE',
  'BLOCKED',
  'CANCELLED',
  'SUPERSEDED',
])

export interface OwnerTaskTransitionInput {
  schemaVersion: 2
  projectRoot: string
  taskId: string
  actorId: string
  to: 'IN_PROGRESS' | 'CANDIDATE' | 'BLOCKED' | 'CANCELLED' | 'SUPERSEDED'
  artifacts: Array<{ kind: string; path: string }>
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort())
}

export function planOwnerTaskTransition(input: unknown): TaskTransitionPlan {
  if (!record(input) || !exactKeys(input, [
    'schemaVersion',
    'projectRoot',
    'taskId',
    'actorId',
    'to',
    'artifacts',
  ]) || input.schemaVersion !== 2
    || typeof input.projectRoot !== 'string'
    || typeof input.taskId !== 'string'
    || typeof input.actorId !== 'string'
    || typeof input.to !== 'string'
    || !ownerTargets.has(input.to as TaskState)
    || !Array.isArray(input.artifacts)
    || input.artifacts.length === 0
    || input.artifacts.some((artifact) => (
      !record(artifact)
      || !exactKeys(artifact, ['kind', 'path'])
      || typeof artifact.kind !== 'string'
      || artifact.kind.length === 0
      || typeof artifact.path !== 'string'
      || artifact.path.length === 0
    ))) throw new Error('OWNER_TASK_TRANSITION_INPUT_INVALID')

  return planTaskTransition({
    projectRoot: input.projectRoot,
    taskId: input.taskId,
    actorId: input.actorId,
    to: input.to as OwnerTaskTransitionInput['to'],
    artifacts: input.artifacts as OwnerTaskTransitionInput['artifacts'],
  })
}

export function applyOwnerTaskTransition(
  plan: TaskTransitionPlan,
  approvedDigest: string,
): { applied: boolean; errors: string[] } {
  return applyTaskTransition(plan, approvedDigest)
}
