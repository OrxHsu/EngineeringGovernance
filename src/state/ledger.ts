import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'

import { parse } from 'yaml'

import { normalizeActorId } from '../model/actor.js'
import { canonicalDigest } from '../model/digest.js'
import type { TaskState, ValidationResult } from '../model/types.js'
import type { Risk } from '../model/types.js'
import { validateDocument } from '../policy/load.js'
import { validateHardenedTaskContract } from '../policy/task-contract.js'
import { applyPlannedWrites } from '../project/mutate.js'
import { canTransition, validateAcceptanceAuthority } from './transitions.js'
import { verifyContractReadinessArtifact } from './contract-readiness.js'

export interface ArtifactReference {
  kind: string
  path: string
  sha256: string
}

export interface TaskEvent {
  schemaVersion: 2
  sequence: number
  previousEventDigest: string | null
  from: TaskState | null
  to: TaskState
  actorId: string
  contractDigest: string
  artifactRefs: ArtifactReference[]
  eventDigest: string
}

export interface TaskLedgerValidation extends ValidationResult {
  events: TaskEvent[]
  currentState?: TaskState
  ledgerPath?: string
}

interface LedgerContract {
  schemaVersion: 2
  taskId: string
  contractDigest: string
  implementationOwner: string
  risk: Risk
  contractReadiness?: { required: boolean; reviewPath: string; gateVersion: string }
  [key: string]: unknown
}

const ownerTransitionTargets = new Set<TaskState>([
  'IN_PROGRESS',
  'CANDIDATE',
  'BLOCKED',
  'CANCELLED',
  'SUPERSEDED',
])

function transitionAuthorityErrors(input: {
  contract: LedgerContract
  actorId: string
  to: TaskState
  artifacts: Array<{ kind: string; path: string }>
}): string[] {
  const errors: string[] = []
  if (ownerTransitionTargets.has(input.to) && input.actorId !== input.contract.implementationOwner) {
    errors.push('TASK_TRANSITION_IMPLEMENTATION_OWNER_REQUIRED')
  }
  if (input.to === 'ACCEPTED' || input.to === 'REPAIR_REQUIRED') {
    errors.push(...validateAcceptanceAuthority(
      input.contract.risk,
      input.contract.implementationOwner,
      input.actorId,
    ).errors)
  }
  const kindCount = (kind: string): number => input.artifacts.filter((artifact) => artifact.kind === kind).length
  if (input.to === 'CANDIDATE' && (kindCount('candidate') !== 1 || kindCount('evidence') !== 1)) {
    errors.push('TASK_CANDIDATE_TRANSITION_ARTIFACT_SET_INVALID')
  }
  if ((input.to === 'ACCEPTED' || input.to === 'REPAIR_REQUIRED')
    && (kindCount('review') !== 1 || kindCount('verification') !== 1)) {
    errors.push('TASK_REVIEW_TRANSITION_ARTIFACT_SET_INVALID')
  }
  if (input.to === 'CLOSED' && (kindCount('closure') !== 1 || kindCount('status') < 1)) {
    errors.push('TASK_CLOSE_TRANSITION_ARTIFACT_SET_INVALID')
  }
  return [...new Set(errors)].sort()
}

function contractReadinessErrors(input: {
  projectRoot: string
  taskId: string
  contract: LedgerContract
  to: TaskState
  artifacts: Array<{ kind: string; path: string }>
}): string[] {
  if (input.to !== 'IN_PROGRESS' || input.contract.contractReadiness?.required !== true) return []
  if (input.artifacts.length !== 1 || input.artifacts[0]?.kind !== 'contract-review') {
    return ['TASK_CONTRACT_READINESS_ARTIFACT_SET_INVALID']
  }
  const expected = `.delivery/tasks/${input.taskId}/contract-review.yaml`
  if (input.artifacts[0].path !== expected) return ['TASK_CONTRACT_READINESS_PATH_INVALID']
  const result = verifyContractReadinessArtifact(
    input.projectRoot,
    input.taskId,
    join(input.projectRoot, expected),
  )
  return result.valid ? [] : result.errors.map((error) => `TASK_CONTRACT_READINESS_INVALID:${error}`)
}

export interface TaskTransitionPlan {
  schemaVersion: 2
  projectRoot: string
  taskId: string
  contract: { path: string; sha256: string; digest: string }
  ledger: { path: string; beforeSha256: string }
  event: TaskEvent
  digest: string
}

function sha256(input: string | Uint8Array): string {
  return createHash('sha256').update(input).digest('hex')
}

function safeTaskId(value: string, label: string): void {
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(value)) throw new Error(`${label}_INVALID`)
}

export function canonicalTaskPath(projectRoot: string, taskId: string, name: string): string {
  safeTaskId(taskId, 'TASK_ID')
  const root = realpathSync(resolve(projectRoot))
  const unresolved = join(root, '.delivery', 'tasks', taskId, name)
  const parent = existsSync(join(root, '.delivery', 'tasks', taskId))
    ? realpathSync(join(root, '.delivery', 'tasks', taskId))
    : join(root, '.delivery', 'tasks', taskId)
  const relativeParent = relative(root, parent)
  if (relativeParent.startsWith('..') || isAbsolute(relativeParent)) {
    throw new Error('TASK_DIRECTORY_OUTSIDE_PROJECT')
  }
  return unresolved
}

export function createTaskEvent(input: Omit<TaskEvent, 'eventDigest'>): TaskEvent {
  return { ...input, eventDigest: canonicalDigest(input) }
}

export function initialTaskEvent(input: {
  actorId: string
  contractDigest: string
  contractPath: string
  contractSha256: string
}): TaskEvent {
  return createTaskEvent({
    schemaVersion: 2,
    sequence: 1,
    previousEventDigest: null,
    from: null,
    to: 'DEFINED',
    actorId: input.actorId,
    contractDigest: input.contractDigest,
    artifactRefs: [{
      kind: 'contract',
      path: input.contractPath,
      sha256: input.contractSha256,
    }],
  })
}

export function readTaskLedger(input: {
  projectRoot: string
  taskId: string
  contractDigest: string
  contractSha256: string
  implementationOwner: string
}): TaskLedgerValidation {
  const errors: string[] = []
  let authorityContract: LedgerContract | undefined
  try {
    const loaded = loadLedgerContract(input.projectRoot, input.taskId)
    authorityContract = loaded.contract
    if (
      sha256(loaded.raw) !== input.contractSha256
      || loaded.contract.contractDigest !== input.contractDigest
      || loaded.contract.implementationOwner !== input.implementationOwner
    ) errors.push('TASK_LEDGER_CONTRACT_IDENTITY_MISMATCH')
  } catch {
    errors.push('TASK_LEDGER_CONTRACT_INVALID')
  }
  let ledgerPath: string
  try {
    ledgerPath = canonicalTaskPath(input.projectRoot, input.taskId, 'ledger.jsonl')
    if (!existsSync(ledgerPath) || lstatSync(ledgerPath).isSymbolicLink() || !lstatSync(ledgerPath).isFile()) {
      return { valid: false, errors: [...errors, 'TASK_LEDGER_UNREADABLE'], events: [] }
    }
    ledgerPath = realpathSync(ledgerPath)
  } catch {
    return { valid: false, errors: [...errors, 'TASK_LEDGER_UNREADABLE'], events: [] }
  }

  const lines = readFileSync(ledgerPath, 'utf8').split('\n').filter((line) => line.length > 0)
  if (lines.length === 0) return { valid: false, errors: ['TASK_LEDGER_EMPTY'], events: [], ledgerPath }
  const events: TaskEvent[] = []
  for (const [index, line] of lines.entries()) {
    let event: TaskEvent
    try {
      event = JSON.parse(line) as TaskEvent
    } catch {
      errors.push(`TASK_EVENT_JSON_INVALID:${index + 1}`)
      continue
    }
    const schema = validateDocument('task-event', event)
    if (!schema.valid) {
      errors.push(...schema.errors.map((error) => `TASK_EVENT_SCHEMA_INVALID:${index + 1}:${error}`))
      continue
    }
    const { eventDigest, ...unsigned } = event
    if (canonicalDigest(unsigned) !== eventDigest) errors.push(`TASK_EVENT_DIGEST_INVALID:${index + 1}`)
    if (event.sequence !== index + 1) errors.push(`TASK_EVENT_SEQUENCE_INVALID:${index + 1}`)
    if (event.contractDigest !== input.contractDigest) {
      errors.push(`TASK_EVENT_CONTRACT_MISMATCH:${index + 1}`)
    }
    const previous = events.at(-1)
    if (index === 0) {
      if (event.previousEventDigest !== null || event.from !== null || event.to !== 'DEFINED') {
        errors.push('TASK_LEDGER_INITIAL_TRANSITION_INVALID')
      }
      if (event.actorId !== input.implementationOwner) errors.push('TASK_LEDGER_INITIAL_OWNER_MISMATCH')
      const expectedContractPath = `.delivery/tasks/${input.taskId}/contract.yaml`
      if (
        event.artifactRefs.length !== 1
        || event.artifactRefs[0]?.kind !== 'contract'
        || event.artifactRefs[0]?.path !== expectedContractPath
        || event.artifactRefs[0]?.sha256 !== input.contractSha256
      ) errors.push('TASK_LEDGER_INITIAL_CONTRACT_REF_MISMATCH')
    } else if (previous !== undefined) {
      if (event.previousEventDigest !== previous.eventDigest) {
        errors.push(`TASK_EVENT_PREVIOUS_DIGEST_MISMATCH:${index + 1}`)
      }
      if (event.from !== previous.to || !canTransition(previous.to, event.to)) {
        errors.push(`TASK_EVENT_TRANSITION_INVALID:${index + 1}`)
      }
      if (authorityContract !== undefined) {
        errors.push(...transitionAuthorityErrors({
          contract: authorityContract,
          actorId: event.actorId,
          to: event.to,
          artifacts: event.artifactRefs,
        }).map((error) => `${error}:${index + 1}`))
        errors.push(...contractReadinessErrors({
          projectRoot: input.projectRoot,
          taskId: input.taskId,
          contract: authorityContract,
          to: event.to,
          artifacts: event.artifactRefs,
        }).map((error) => `${error}:${index + 1}`))
      }
    }
    events.push(event)
  }
  const uniqueErrors = [...new Set(errors)].sort()
  return {
    valid: uniqueErrors.length === 0,
    errors: uniqueErrors,
    events,
    ...(events.at(-1) === undefined ? {} : { currentState: events.at(-1)!.to }),
    ledgerPath,
  }
}

export function ledgerContentDigest(path: string): string {
  return sha256(readFileSync(path))
}

function loadLedgerContract(projectRoot: string, taskId: string): {
  root: string
  path: string
  raw: Buffer
  contract: LedgerContract
} {
  const root = realpathSync(resolve(projectRoot))
  const unresolved = canonicalTaskPath(root, taskId, 'contract.yaml')
  if (!existsSync(unresolved) || lstatSync(unresolved).isSymbolicLink() || !lstatSync(unresolved).isFile()) {
    throw new Error('TASK_CONTRACT_UNREADABLE')
  }
  const path = realpathSync(unresolved)
  const raw = readFileSync(path)
  const contract = parse(raw.toString('utf8')) as LedgerContract
  const semantic = validateHardenedTaskContract(contract)
  if (!semantic.valid) throw new Error(`TASK_CONTRACT_INVALID:${semantic.errors.join(',')}`)
  if (contract.taskId !== taskId) throw new Error('TASK_CONTRACT_ID_MISMATCH')
  return { root, path, raw, contract }
}

function artifactReference(root: string, input: { kind: string; path: string }): ArtifactReference {
  if (input.kind.trim().length === 0) throw new Error('TASK_TRANSITION_ARTIFACT_KIND_REQUIRED')
  const unresolved = resolve(input.path)
  if (!existsSync(unresolved) || lstatSync(unresolved).isSymbolicLink() || !lstatSync(unresolved).isFile()) {
    throw new Error(`TASK_TRANSITION_ARTIFACT_UNSAFE:${input.path}`)
  }
  const path = realpathSync(unresolved)
  const relativePath = relative(root, path)
  if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
    throw new Error(`TASK_TRANSITION_ARTIFACT_OUTSIDE_PROJECT:${input.path}`)
  }
  return { kind: input.kind, path: relativePath, sha256: sha256(readFileSync(path)) }
}

export function planTaskTransition(input: {
  projectRoot: string
  taskId: string
  actorId: string
  to: TaskState
  artifacts: Array<{ kind: string; path: string }>
}): TaskTransitionPlan {
  if (input.artifacts.length === 0) throw new Error('TASK_TRANSITION_ARTIFACT_REQUIRED')
  const loaded = loadLedgerContract(input.projectRoot, input.taskId)
  const ledger = readTaskLedger({
    projectRoot: loaded.root,
    taskId: input.taskId,
    contractDigest: loaded.contract.contractDigest,
    contractSha256: sha256(loaded.raw),
    implementationOwner: loaded.contract.implementationOwner,
  })
  if (!ledger.valid || ledger.currentState === undefined || ledger.ledgerPath === undefined) {
    throw new Error(`TASK_LEDGER_INVALID:${ledger.errors.join(',')}`)
  }
  if (!canTransition(ledger.currentState, input.to)) {
    throw new Error(`TASK_TRANSITION_NOT_ALLOWED:${ledger.currentState}:${input.to}`)
  }
  const actorId = normalizeActorId(input.actorId)
  const authorityErrors = transitionAuthorityErrors({
    contract: loaded.contract,
    actorId,
    to: input.to,
    artifacts: input.artifacts,
  })
  if (authorityErrors.length > 0) throw new Error(authorityErrors.join(','))
  const artifactRefs = input.artifacts.map((artifact) => artifactReference(loaded.root, artifact))
  const readinessErrors = contractReadinessErrors({
    projectRoot: loaded.root,
    taskId: input.taskId,
    contract: loaded.contract,
    to: input.to,
    artifacts: artifactRefs,
  })
  if (readinessErrors.length > 0) throw new Error(readinessErrors.join(','))
  const previous = ledger.events.at(-1)!
  const event = createTaskEvent({
    schemaVersion: 2,
    sequence: previous.sequence + 1,
    previousEventDigest: previous.eventDigest,
    from: previous.to,
    to: input.to,
    actorId,
    contractDigest: loaded.contract.contractDigest,
    artifactRefs,
  })
  const unsigned = {
    schemaVersion: 2 as const,
    projectRoot: loaded.root,
    taskId: input.taskId,
    contract: {
      path: relative(loaded.root, loaded.path),
      sha256: sha256(loaded.raw),
      digest: loaded.contract.contractDigest,
    },
    ledger: {
      path: relative(loaded.root, ledger.ledgerPath),
      beforeSha256: ledgerContentDigest(ledger.ledgerPath),
    },
    event,
  }
  return { ...unsigned, digest: canonicalDigest(unsigned) }
}

function planErrors(plan: TaskTransitionPlan, approvedDigest: string): string[] {
  const { digest, ...unsigned } = plan
  const errors: string[] = []
  if (canonicalDigest(unsigned) !== digest || approvedDigest !== digest) {
    errors.push('TASK_TRANSITION_PLAN_DIGEST_MISMATCH')
    return errors
  }
  let loaded: ReturnType<typeof loadLedgerContract>
  try {
    loaded = loadLedgerContract(plan.projectRoot, plan.taskId)
  } catch {
    return ['TASK_TRANSITION_CONTRACT_INVALID']
  }
  if (
    relative(loaded.root, loaded.path) !== plan.contract.path
    || sha256(loaded.raw) !== plan.contract.sha256
    || loaded.contract.contractDigest !== plan.contract.digest
  ) errors.push('TASK_TRANSITION_CONTRACT_DRIFT')
  const ledger = readTaskLedger({
    projectRoot: loaded.root,
    taskId: plan.taskId,
    contractDigest: loaded.contract.contractDigest,
    contractSha256: sha256(loaded.raw),
    implementationOwner: loaded.contract.implementationOwner,
  })
  if (!ledger.valid || ledger.currentState === undefined || ledger.ledgerPath === undefined) {
    errors.push('TASK_TRANSITION_LEDGER_INVALID')
    return errors
  }
  const previous = ledger.events.at(-1)!
  if (
    ledgerContentDigest(ledger.ledgerPath) !== plan.ledger.beforeSha256
    || relative(loaded.root, ledger.ledgerPath) !== plan.ledger.path
    || plan.event.sequence !== previous.sequence + 1
    || plan.event.previousEventDigest !== previous.eventDigest
    || plan.event.from !== previous.to
    || !canTransition(previous.to, plan.event.to)
  ) errors.push('TASK_TRANSITION_LEDGER_DRIFT')
  const { eventDigest, ...unsignedEvent } = plan.event
  if (
    canonicalDigest(unsignedEvent) !== eventDigest
    || normalizeActorId(plan.event.actorId) !== plan.event.actorId
    || plan.event.contractDigest !== loaded.contract.contractDigest
  ) errors.push('TASK_TRANSITION_EVENT_INVALID')
  errors.push(...transitionAuthorityErrors({
    contract: loaded.contract,
    actorId: plan.event.actorId,
    to: plan.event.to,
    artifacts: plan.event.artifactRefs,
  }))
  errors.push(...contractReadinessErrors({
    projectRoot: loaded.root,
    taskId: plan.taskId,
    contract: loaded.contract,
    to: plan.event.to,
    artifacts: plan.event.artifactRefs,
  }))
  for (const reference of plan.event.artifactRefs) {
    try {
      const current = artifactReference(loaded.root, {
        kind: reference.kind,
        path: join(loaded.root, reference.path),
      })
      if (JSON.stringify(current) !== JSON.stringify(reference)) {
        errors.push(`TASK_TRANSITION_ARTIFACT_DRIFT:${reference.path}`)
      }
    } catch {
      errors.push(`TASK_TRANSITION_ARTIFACT_DRIFT:${reference.path}`)
    }
  }
  return [...new Set(errors)].sort()
}

export function applyTaskTransition(
  plan: TaskTransitionPlan,
  approvedDigest: string,
): { applied: boolean; errors: string[] } {
  const errors = planErrors(plan, approvedDigest)
  if (errors.length > 0) return { applied: false, errors }
  const ledgerPath = join(plan.projectRoot, plan.ledger.path)
  const before = readFileSync(ledgerPath, 'utf8')
  try {
    applyPlannedWrites([{
      path: ledgerPath,
      beforeDigest: plan.ledger.beforeSha256,
      after: `${before}${JSON.stringify(plan.event)}\n`,
    }], { dryRun: false })
  } catch {
    return { applied: false, errors: ['TASK_TRANSITION_APPLY_DRIFT'] }
  }
  return { applied: true, errors: [] }
}
