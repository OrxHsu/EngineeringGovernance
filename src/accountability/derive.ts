import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { extname, isAbsolute, join, resolve } from 'node:path'

import { parse } from 'yaml'

import { normalizeActorId } from '../model/actor.js'
import { canonicalDigest } from '../model/digest.js'
import { validateDocument } from '../policy/load.js'
import {
  ACCOUNTABILITY_EVENTS_PATH,
  ACCOUNTABILITY_GENESIS_DIGEST,
  assertAccountabilityPolicy,
  normalizeDefectClass,
  permissionsForStanding,
  scoreForFinding,
  standingForScore,
  type Standing,
} from './policy.js'
import {
  policyDigestAllowedForProject,
  policyDigestForProject,
  readActorRegistry,
  assertAuthorizationContextTime,
  validateAuthorizationReference,
  type AccountabilityBootstrapActor,
  type AuthorizationContext,
  type AuthorizationReference,
} from './registry.js'
import { hasPermanentGates } from './permanent-gates.js'

export type AccountabilityEventType = 'finding_assessed' | 'standing_changed' | 'calibration_recorded' | 'calibration_reset' | 'recognition_granted' | 'recognition_revoked'

export interface AccountabilityIncident {
  schemaVersion: 1
  artifactType: 'engineering-governance-accountability-incident-v1'
  incidentId: string
  projectRoot: string
  subjectActorId: string
  reportedBy: string
  failureContext: {
    blockedComponent: 'governance-tool' | 'contract-review' | 'implementation-review' | 'task-lifecycle' | 'other'
    failureCode: string
    conversationId?: string
    observedAt: string
  }
  finding: {
    findingId: string
    severity: 'BLOCKER' | 'HIGH' | 'MEDIUM' | 'LOW'
    classification: 'contract_violation' | 'newly_discovered_defect' | 'new_requirement'
    defectClass: string
    responsibleRole: 'contract_author' | 'implementation_owner' | 'contract_reviewer' | 'implementation_reviewer' | 'tool' | 'none'
    culpability: 'culpable' | 'non_culpable_new_requirement' | 'non_culpable_tool_defect' | 'missed_existing_blocker'
    observation: string
  }
  evidenceRefs: Array<{ path: string; rawSha256: string; semanticDigest: string }>
  grantor: { id: 'user-authority'; role: 'user'; trustLevel: 'local-claim' }
  issuedAt: string
  expiresAt: string
  status: 'approved'
}

export interface AccountabilityEvent {
  schemaVersion: 1
  artifactType: 'engineering-governance-accountability-event-v1'
  eventType: AccountabilityEventType
  sequence: number
  priorEventDigest: string
  eventDigest: string
  policyDigest: string
  subjectActorId: string
  source: {
    taskId: string
    artifactPath: string
    rawSha256: string
    semanticDigest: string
    reviewId: string
    findingId: string
  }
  score: { base: number; repeatSurcharge: number; immediateSuspension: boolean; delta: number }
  scoreChange?: {
    delta: number
    reason: 'finding' | 'clean-task' | 'remediation' | 'time-decay'
    isFirstOffense?: boolean
    isRepeatOffense?: boolean
    repeatCount?: number
    defectClass?: string
  }
  lifetimePenaltyScore: number
  activePenaltyScore: number
  standing: Standing
  permissions: string[]
  authorization: AuthorizationReference | 'none'
  incident?: AccountabilityIncident
  occurredAt: string
}

export interface AccountabilityStatus {
  schemaVersion: 1
  artifactType: 'engineering-governance-accountability-status-v1'
  policyVersion: 'strict-v1'
  actorId: string
  aliases: string[]
  lifetimePenaltyScore: number
  activePenaltyScore: number
  standing: Standing
  permissions: string[]
  unresolvedDefectClasses: string[]
  calibration: {
    currentStage: string
    consecutiveCleanCount: number
    requiredCleanCount: number
    qualifyingRefs: string[]
    lastResetRef: string | null
  }
  recognition: { status: 'NONE' | 'RELIABLE'; grantedByEvent: string | null; revokedByEvent: string | null }
  sourceEvents: Array<{ sequence: number; eventDigest: string; eventType: string; sourceRef: string }>
}

interface ActorState {
  lifetime: number
  active: number
  forcedSuspended: boolean
  unresolved: Set<string>
  offenses: Map<string, number>
  calibrations: string[]
  lastResetRef: string | null
  recognition: AccountabilityStatus['recognition']
  initialized: boolean
}

type DerivedSnapshot = {
  events: AccountabilityEvent[]
  states: Map<string, ActorState>
  registry: ReturnType<typeof readActorRegistry>
}

let scopedReadCache: Map<string, DerivedSnapshot> | undefined

export function withAccountabilityReadScope<T>(action: () => T): T {
  const previous = scopedReadCache
  scopedReadCache = new Map()
  try { return action() } finally { scopedReadCache = previous }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function eventsPath(projectRoot: string): string {
  const root = realpathSync(resolve(projectRoot))
  const path = join(root, ACCOUNTABILITY_EVENTS_PATH)
  const parent = join(root, '.delivery', 'accountability')
  if (existsSync(parent) && (lstatSync(parent).isSymbolicLink() || !lstatSync(parent).isDirectory())) throw new Error('ACCOUNTABILITY_EVENTS_PARENT_UNSAFE')
  return path
}

function sha256(input: string | Uint8Array): string {
  return createHash('sha256').update(input).digest('hex')
}

function sourceSemantic(path: string, raw: Buffer): string {
  if (path.endsWith('.jsonl')) {
    try { return canonicalDigest(raw.toString('utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))) } catch { throw new Error('ACCOUNTABILITY_EVENT_SOURCE_INVALID') }
  }
  if (['.yaml', '.yml', '.json'].includes(extname(path))) {
    try { return canonicalDigest(parse(raw.toString('utf8'))) } catch { throw new Error('ACCOUNTABILITY_EVENT_SOURCE_INVALID') }
  }
  return canonicalDigest(raw.toString('utf8'))
}

function exactSource(event: AccountabilityEvent, context: AuthorizationContext, projectRoot: string): { path: string; kind: string } {
  const matches = context.bootstrap.sources.filter((candidate) => (
    candidate.path === event.source.artifactPath
    && candidate.rawSha256 === event.source.rawSha256
    && candidate.semanticDigest === event.source.semanticDigest
  ))
  if (matches.length !== 1) throw new Error('ACCOUNTABILITY_EVENT_SOURCE_NOT_AUTHORIZED')
  const declared = matches[0]!
  const root = realpathSync(resolve(projectRoot))
  const unresolved = isAbsolute(declared.path) ? resolve(declared.path) : resolve(root, declared.path)
  if (!existsSync(unresolved) || lstatSync(unresolved).isSymbolicLink() || !lstatSync(unresolved).isFile() || realpathSync(unresolved) !== unresolved) {
    throw new Error('ACCOUNTABILITY_EVENT_SOURCE_UNSAFE')
  }
  const raw = readFileSync(unresolved)
  if (sha256(raw) !== declared.rawSha256) throw new Error('ACCOUNTABILITY_EVENT_SOURCE_RAW_MISMATCH')
  if (sourceSemantic(unresolved, raw) !== declared.semanticDigest) throw new Error('ACCOUNTABILITY_EVENT_SOURCE_SEMANTIC_MISMATCH')
  if (!isAbsolute(declared.path)) {
    const taskMatch = /^\.delivery\/tasks\/([^/]+)\//u.exec(declared.path)
    if (taskMatch !== null && taskMatch[1] !== event.source.taskId) throw new Error('ACCOUNTABILITY_EVENT_SOURCE_TASK_MISMATCH')
  }
  return { path: unresolved, kind: declared.kind }
}

function freshState(): ActorState {
  return {
    lifetime: 0,
    active: 0,
    forcedSuspended: false,
    unresolved: new Set<string>(),
    offenses: new Map<string, number>(),
    calibrations: [],
    lastResetRef: null,
    recognition: { status: 'NONE', grantedByEvent: null, revokedByEvent: null },
    initialized: false,
  }
}

function exactStateFields(event: AccountabilityEvent, state: ActorState): void {
  const standing = standingForScore(state.active, state.forcedSuspended)
  if (
    event.lifetimePenaltyScore !== state.lifetime
    || event.activePenaltyScore !== state.active
    || event.standing !== standing
    || JSON.stringify(event.permissions) !== JSON.stringify(permissionsForStanding(standing))
  ) throw new Error('ACCOUNTABILITY_EVENT_TRANSITION_INVALID')
}

function bootstrapActor(context: AuthorizationContext, actorId: string): AccountabilityBootstrapActor {
  const matches = context.bootstrap.actors.filter((actor) => normalizeActorId(actor.actorId) === actorId)
  if (matches.length !== 1) throw new Error('ACCOUNTABILITY_EVENT_ACTOR_NOT_AUTHORIZED')
  return matches[0]!
}

function bootstrapSnapshot(
  event: AccountabilityEvent,
  state: ActorState,
  context: AuthorizationContext,
  sourceKind: string,
): void {
  const actor = bootstrapActor(context, event.subjectActorId)
  if (
    event.eventType !== 'finding_assessed'
    || actor.activePenaltyScore === 0
    || event.lifetimePenaltyScore !== actor.lifetimePenaltyScore
    || event.activePenaltyScore !== actor.activePenaltyScore
    || event.standing !== actor.standing
    || JSON.stringify(event.permissions) !== JSON.stringify(actor.permissions)
    || event.score.delta <= 0
  ) throw new Error('ACCOUNTABILITY_EVENT_TRANSITION_INVALID')
  const finding = context.bootstrap.findings.find((candidate) => candidate.findingId === event.source.findingId)
  if (finding !== undefined) {
    if (
      normalizeActorId(String(finding.responsibleActorId)) !== event.subjectActorId
      || finding.scoreDelta !== event.score.delta
      || finding.origin.taskId !== event.source.taskId
      || finding.origin.reviewId !== event.source.reviewId
      || !finding.origin.evidenceRefs.includes(event.source.artifactPath)
    ) throw new Error('ACCOUNTABILITY_EVENT_TRANSITION_INVALID')
  } else if (sourceKind !== 'report' || event.score.delta !== actor.activePenaltyScore) {
    throw new Error('ACCOUNTABILITY_EVENT_TRANSITION_INVALID')
  }
  for (const historical of context.bootstrap.findings.filter((candidate) => (
    candidate.responsibleActorId !== null
    && normalizeActorId(candidate.responsibleActorId) === event.subjectActorId
    && candidate.scoreDelta > 0
  ))) {
    const defectClass = normalizeDefectClass(historical.defectClass)
    state.offenses.set(defectClass, (state.offenses.get(defectClass) ?? 0) + 1)
  }
  for (const defectClass of actor.unresolvedDefectClasses) state.unresolved.add(normalizeDefectClass(defectClass))
  state.lifetime = actor.lifetimePenaltyScore
  state.active = actor.activePenaltyScore
  state.forcedSuspended = actor.standing === 'SUSPENDED' && actor.activePenaltyScore < 12
  state.initialized = true
}

function acceptedCalibrationSource(path: string, kind: string, event: AccountabilityEvent, state: ActorState): void {
  if (kind !== 'review') throw new Error('ACCOUNTABILITY_EVENT_TRANSITION_INVALID')
  let review: unknown
  try { review = parse(readFileSync(path, 'utf8')) } catch { throw new Error('ACCOUNTABILITY_EVENT_TRANSITION_INVALID') }
  if (!record(review) || review.decision !== 'ACCEPTED' || review.taskId !== event.source.taskId || review.reviewId !== event.source.reviewId) {
    throw new Error('ACCOUNTABILITY_EVENT_TRANSITION_INVALID')
  }
  if (state.calibrations.includes(event.source.taskId)) throw new Error('ACCOUNTABILITY_EVENT_TRANSITION_INVALID')
}

function validateNormalTransition(
  projectRoot: string,
  event: AccountabilityEvent,
  state: ActorState,
  context: AuthorizationContext,
  source: { path: string; kind: string },
  priorEvents: AccountabilityEvent[],
): void {
  if (!state.initialized && event.eventType !== 'finding_assessed') throw new Error('ACCOUNTABILITY_EVENT_TRANSITION_INVALID')
  if (event.eventType === 'finding_assessed') {
    const finding = context.bootstrap.findings.find((candidate) => candidate.findingId === event.source.findingId)
    const expected = finding === undefined ? undefined : scoreForFinding(
      finding.severity,
      finding.defectClass,
      state.offenses,
      finding.classification,
      finding.culpability,
    )
    if (
      finding === undefined
      || expected === undefined
      || normalizeActorId(String(finding.responsibleActorId)) !== event.subjectActorId
      || finding.scoreDelta !== event.score.delta
      || event.score.delta !== event.score.base + event.score.repeatSurcharge
      || event.score.base !== expected.base
      || event.score.repeatSurcharge !== expected.repeatSurcharge
      || event.score.immediateSuspension !== expected.immediateSuspension
      || event.score.delta !== expected.delta
      || event.scoreChange?.reason !== 'finding'
      || event.scoreChange.delta !== expected.delta
      || event.scoreChange.defectClass !== expected.defectClass
      || event.scoreChange.repeatCount !== expected.repeatCount
      || event.scoreChange.isFirstOffense !== expected.isFirstOffense
      || event.scoreChange.isRepeatOffense !== !expected.isFirstOffense
    ) throw new Error('ACCOUNTABILITY_EVENT_TRANSITION_INVALID')
    state.lifetime += event.score.delta
    state.active += event.score.delta
    state.forcedSuspended ||= event.score.immediateSuspension
    state.unresolved.add(expected.defectClass)
    state.offenses.set(expected.defectClass, expected.repeatCount + 1)
    state.calibrations = []
    state.lastResetRef = event.eventDigest
    state.recognition = { status: 'NONE', grantedByEvent: state.recognition.grantedByEvent, revokedByEvent: event.eventDigest }
    state.initialized = true
    exactStateFields(event, state)
    return
  }
  if (event.score.base !== 0 || event.score.repeatSurcharge !== 0 || event.score.delta !== 0 || event.score.immediateSuspension) {
    throw new Error('ACCOUNTABILITY_EVENT_TRANSITION_INVALID')
  }
  if (event.eventType === 'calibration_recorded') {
    acceptedCalibrationSource(source.path, source.kind, event, state)
    const ids = [event.subjectActorId, context.supervisorId, context.contractReviewerId, context.implementationReviewerId].filter((value): value is string => value !== undefined)
    if (ids.length < 3 || new Set(ids).size !== ids.length) throw new Error('ACCOUNTABILITY_EVENT_TRANSITION_INVALID')
    state.calibrations.push(event.source.taskId)
    exactStateFields(event, state)
    return
  }
  if (event.eventType === 'calibration_reset') {
    state.calibrations = []
    state.lastResetRef = event.eventDigest
    exactStateFields(event, state)
    return
  }
  if (event.eventType === 'standing_changed') {
    const standing = standingForScore(state.active, state.forcedSuspended)
    const target = standing === 'SUSPENDED'
      ? { count: 2, active: 8 }
      : standing === 'PROBATION'
        ? { count: 1, active: 5 }
        : standing === 'WATCH'
          ? { count: 1, active: 3 }
          : standing === 'WARNING'
            ? { count: 1, active: 0 }
            : undefined
    if (target === undefined || state.calibrations.length < target.count || event.source.findingId !== 'reinstatement') {
      throw new Error('ACCOUNTABILITY_EVENT_TRANSITION_INVALID')
    }
    if ((standing === 'SUSPENDED' || standing === 'PROBATION')
      && !hasPermanentGates(projectRoot, event.subjectActorId, [...state.unresolved])) {
      throw new Error('ACCOUNTABILITY_RECOVERY_PERMANENT_GATES_REQUIRED')
    }
    state.active = target.active
    state.forcedSuspended = false
    state.unresolved.clear()
    state.calibrations = []
    exactStateFields(event, state)
    return
  }
  if (event.eventType === 'recognition_granted') {
    if (state.active !== 0 || state.forcedSuspended || state.calibrations.length < 12 || state.recognition.status !== 'NONE') {
      throw new Error('ACCOUNTABILITY_EVENT_TRANSITION_INVALID')
    }
    state.recognition = { status: 'RELIABLE', grantedByEvent: event.eventDigest, revokedByEvent: null }
    exactStateFields(event, state)
    return
  }
  if (event.eventType === 'recognition_revoked') {
    if (state.recognition.status !== 'RELIABLE') throw new Error('ACCOUNTABILITY_EVENT_TRANSITION_INVALID')
    state.recognition = { status: 'NONE', grantedByEvent: state.recognition.grantedByEvent, revokedByEvent: event.eventDigest }
    exactStateFields(event, state)
    return
  }
  const _exhaustive: never = event.eventType
  void _exhaustive
  void priorEvents
}

function applyEvent(
  projectRoot: string,
  event: AccountabilityEvent,
  states: Map<string, ActorState>,
  priorEvents: AccountabilityEvent[],
  authorizationContexts: Map<string, AuthorizationContext>,
): void {
  const state = states.get(event.subjectActorId) ?? freshState()
  if (event.incident !== undefined) {
    applyIncidentEvent(projectRoot, event, state)
    states.set(event.subjectActorId, state)
    return
  }
  if (event.eventType === 'standing_changed') {
    const standing = standingForScore(state.active, state.forcedSuspended)
    const targetCount = standing === 'SUSPENDED' ? 2 : standing === 'GOOD_STANDING' ? Number.POSITIVE_INFINITY : 1
    if (!state.initialized || state.calibrations.length < targetCount) throw new Error('ACCOUNTABILITY_EVENT_TRANSITION_INVALID')
  }
  const authorizationKey = JSON.stringify(event.authorization)
  let context = authorizationContexts.get(authorizationKey)
  if (context === undefined) {
    context = validateAuthorizationReference(projectRoot, event.authorization, event.occurredAt)
    authorizationContexts.set(authorizationKey, context)
  } else assertAuthorizationContextTime(context, event.occurredAt)
  bootstrapActor(context, event.subjectActorId)
  const source = exactSource(event, context, projectRoot)
  const reused = priorEvents.some((prior) => record(prior.authorization) && prior.authorization.authorizationId === context.reference.authorizationId)
  if (state.initialized && reused) throw new Error('ACCOUNTABILITY_AUTHORIZATION_REPLAYED')
  if (!state.initialized) bootstrapSnapshot(event, state, context, source.kind)
  else validateNormalTransition(projectRoot, event, state, context, source, priorEvents)
  states.set(event.subjectActorId, state)
}

function parseEvent(projectRoot: string, decoded: unknown, index: number, previous: AccountabilityEvent | undefined): AccountabilityEvent {
  if (!record(decoded) || !validateDocument('accountability-event', decoded).valid) throw new Error('ACCOUNTABILITY_EVENT_SCHEMA_INVALID')
  const event = decoded as unknown as AccountabilityEvent
  if (event.sequence !== index + 1 || event.priorEventDigest !== (previous?.eventDigest ?? ACCOUNTABILITY_GENESIS_DIGEST)) {
    throw new Error('ACCOUNTABILITY_EVENT_CHAIN_INVALID')
  }
  const { eventDigest, ...unsigned } = event
  if (canonicalDigest(unsigned) !== eventDigest) throw new Error('ACCOUNTABILITY_EVENT_DIGEST_INVALID')
  if (!policyDigestAllowedForProject(projectRoot, event.policyDigest)) throw new Error('ACCOUNTABILITY_EVENT_POLICY_INVALID')
  if (previous !== undefined && Date.parse(event.occurredAt) < Date.parse(previous.occurredAt)) throw new Error('ACCOUNTABILITY_EVENT_TIME_ORDER_INVALID')
  return { ...event, subjectActorId: normalizeActorId(event.subjectActorId) }
}

function incidentRawDigest(incident: AccountabilityIncident): string {
  return sha256(`${JSON.stringify(incident, null, 2)}\n`)
}

function applyIncidentEvent(projectRoot: string, event: AccountabilityEvent, state: ActorState): void {
  const incident = event.incident
  if (incident === undefined || event.authorization !== 'none' || event.eventType !== 'finding_assessed') {
    throw new Error('ACCOUNTABILITY_INCIDENT_EVENT_INVALID')
  }
  if (realpathSync(resolve(incident.projectRoot)) !== realpathSync(resolve(projectRoot))) {
    throw new Error('ACCOUNTABILITY_INCIDENT_PROJECT_INVALID')
  }
  const issued = Date.parse(incident.issuedAt)
  const expires = Date.parse(incident.expiresAt)
  const observed = Date.parse(incident.failureContext.observedAt)
  if (!Number.isFinite(issued) || !Number.isFinite(expires) || !Number.isFinite(observed) || expires <= issued || observed > issued) {
    throw new Error('ACCOUNTABILITY_INCIDENT_TIME_INVALID')
  }
  if (incident.finding.culpability === 'culpable' && incident.finding.responsibleRole === 'none') {
    throw new Error('ACCOUNTABILITY_INCIDENT_RESPONSIBILITY_INVALID')
  }
  if (normalizeActorId(incident.subjectActorId) !== event.subjectActorId
    || event.source.taskId !== `incident:${incident.incidentId}`
    || event.source.reviewId !== `incident:${incident.incidentId}`
    || event.source.findingId !== incident.finding.findingId
    || event.occurredAt !== incident.issuedAt
    || event.source.rawSha256 !== incidentRawDigest(incident)
    || event.source.semanticDigest !== canonicalDigest(incident)) {
    throw new Error('ACCOUNTABILITY_INCIDENT_EVENT_BINDING_INVALID')
  }
  const expected = scoreForFinding(
    incident.finding.severity,
    incident.finding.defectClass,
    state.offenses,
    incident.finding.classification,
    incident.finding.culpability,
  )
  if (
    event.score.base !== expected.base
    || event.score.repeatSurcharge !== expected.repeatSurcharge
    || event.score.immediateSuspension !== expected.immediateSuspension
    || event.score.delta !== expected.delta
    || event.scoreChange?.reason !== 'finding'
    || event.scoreChange.delta !== expected.delta
    || event.scoreChange.defectClass !== expected.defectClass
    || event.scoreChange.repeatCount !== expected.repeatCount
    || event.scoreChange.isFirstOffense !== expected.isFirstOffense
    || event.scoreChange.isRepeatOffense !== !expected.isFirstOffense
  ) throw new Error('ACCOUNTABILITY_INCIDENT_SCORE_INVALID')
  state.lifetime += expected.delta
  state.active += expected.delta
  state.forcedSuspended ||= expected.immediateSuspension
  state.unresolved.add(expected.defectClass)
  state.offenses.set(expected.defectClass, expected.repeatCount + 1)
  state.calibrations = []
  state.lastResetRef = event.eventDigest
  state.recognition = { status: 'NONE', grantedByEvent: state.recognition.grantedByEvent, revokedByEvent: event.eventDigest }
  state.initialized = true
  exactStateFields(event, state)
}

function readAndDerive(projectRoot: string, appended?: AccountabilityEvent): DerivedSnapshot {
  const cacheKey = realpathSync(resolve(projectRoot))
  if (appended === undefined) {
    const cached = scopedReadCache?.get(cacheKey)
    if (cached !== undefined) return cached
  }
  assertAccountabilityPolicy(projectRoot)
  const authorizationContexts = new Map<string, AuthorizationContext>()
  const registry = readActorRegistry(projectRoot, authorizationContexts)
  const activeActors = new Set(registry.actors.filter((actor) => actor.active).map((actor) => actor.actorId))
  const path = eventsPath(projectRoot)
  if (existsSync(path) && (lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile() || realpathSync(path) !== path)) throw new Error('ACCOUNTABILITY_EVENTS_UNSAFE')
  const decoded: unknown[] = existsSync(path)
    ? readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line) => {
      try { return JSON.parse(line) } catch { throw new Error('ACCOUNTABILITY_EVENT_JSON_INVALID') }
    })
    : []
  if (appended !== undefined) decoded.push(appended)
  const events: AccountabilityEvent[] = []
  const states = new Map<string, ActorState>()
  for (const [index, value] of decoded.entries()) {
    const event = parseEvent(projectRoot, value, index, events.at(-1))
    if (!activeActors.has(event.subjectActorId)) throw new Error('ACCOUNTABILITY_EVENT_ACTOR_UNAVAILABLE')
    if (event.incident !== undefined
      && event.incident.reportedBy !== 'user-authority'
      && !activeActors.has(normalizeActorId(event.incident.reportedBy))) {
      throw new Error('ACCOUNTABILITY_INCIDENT_REPORTER_UNAVAILABLE')
    }
    applyEvent(projectRoot, event, states, events, authorizationContexts)
    events.push(event)
  }
  for (const actor of registry.actors.filter((candidate) => candidate.active)) {
    const creation = registry.events.find((event) => event.eventType === 'actor_created' && event.actorId === actor.actorId)
    if (creation === undefined) throw new Error('ACCOUNTABILITY_EVENT_BOOTSTRAP_MISSING')
    const authorizationKey = JSON.stringify(creation.authorization)
    let context = authorizationContexts.get(authorizationKey)
    if (context === undefined) {
      context = validateAuthorizationReference(projectRoot, creation.authorization, creation.occurredAt)
      authorizationContexts.set(authorizationKey, context)
    } else assertAuthorizationContextTime(context, creation.occurredAt)
    const expected = context.bootstrap.actors.find((candidate) => normalizeActorId(candidate.actorId) === actor.actorId)
    if (expected === undefined) throw new Error('ACCOUNTABILITY_EVENT_BOOTSTRAP_MISSING')
    const state = states.get(actor.actorId)
    if ((expected.lifetimePenaltyScore > 0 || expected.activePenaltyScore > 0) && (state === undefined || !state.initialized)) {
      throw new Error('ACCOUNTABILITY_EVENT_BOOTSTRAP_MISSING')
    }
  }
  const result = { events, states, registry }
  if (appended === undefined) scopedReadCache?.set(cacheKey, result)
  return result
}

export function readAccountabilityEvents(projectRoot: string): AccountabilityEvent[] {
  return readAndDerive(projectRoot).events
}

export function appendAccountabilityEvent(
  projectRoot: string,
  input: Omit<AccountabilityEvent, 'sequence' | 'priorEventDigest' | 'eventDigest' | 'policyDigest'>,
): AccountabilityEvent {
  const current = readAndDerive(projectRoot)
  const unsigned: Omit<AccountabilityEvent, 'eventDigest'> = {
    ...input,
    subjectActorId: normalizeActorId(input.subjectActorId),
    sequence: current.events.length + 1,
    priorEventDigest: current.events.at(-1)?.eventDigest ?? ACCOUNTABILITY_GENESIS_DIGEST,
    policyDigest: policyDigestForProject(projectRoot),
  }
  const event = { ...unsigned, eventDigest: canonicalDigest(unsigned) }
  readAndDerive(projectRoot, event)
  const path = eventsPath(projectRoot)
  mkdirSync(join(realpathSync(resolve(projectRoot)), '.delivery', 'accountability'), { recursive: true, mode: 0o755 })
  appendFileSync(path, `${JSON.stringify(event)}\n`, { mode: 0o644 })
  return event
}

export function deriveAccountabilityStatus(projectRoot: string, actorOrAlias: string): AccountabilityStatus {
  const derived = readAndDerive(projectRoot)
  const registry = derived.registry
  const normalized = normalizeActorId(actorOrAlias)
  const actor = registry.actors.find((candidate) => candidate.actorId === normalized || candidate.aliases.includes(normalized))
  if (actor === undefined || !actor.active) throw new Error('ACCOUNTABILITY_ACTOR_UNAVAILABLE')
  const state = derived.states.get(actor.actorId) ?? freshState()
  const actorEvents = derived.events.filter((event) => event.subjectActorId === actor.actorId)
  const standing = standingForScore(state.active, state.forcedSuspended)
  const transitionTarget = standing === 'SUSPENDED' ? 2 : standing === 'GOOD_STANDING' ? 12 : 1
  return {
    schemaVersion: 1,
    artifactType: 'engineering-governance-accountability-status-v1',
    policyVersion: 'strict-v1',
    actorId: actor.actorId,
    aliases: actor.aliases,
    lifetimePenaltyScore: state.lifetime,
    activePenaltyScore: state.active,
    standing,
    permissions: permissionsForStanding(standing),
    unresolvedDefectClasses: [...state.unresolved].sort(),
    calibration: {
      currentStage: standing === 'GOOD_STANDING' ? 'RELIABILITY' : standing,
      consecutiveCleanCount: state.calibrations.length,
      requiredCleanCount: transitionTarget,
      qualifyingRefs: [...state.calibrations],
      lastResetRef: state.lastResetRef,
    },
    recognition: state.recognition,
    sourceEvents: actorEvents.map((event) => ({
      sequence: event.sequence,
      eventDigest: event.eventDigest,
      eventType: event.eventType,
      sourceRef: `${event.source.taskId}:${event.source.findingId}`,
    })),
  }
}

export function eventSourceDigest(value: unknown): string {
  return canonicalDigest(value)
}

export function eventRawDigest(value: string | Uint8Array): string {
  return sha256(value)
}
