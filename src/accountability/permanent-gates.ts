import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import { normalizeActorId } from '../model/actor.js'
import { canonicalDigest } from '../model/digest.js'
import { validateDocument } from '../policy/load.js'
import type { Beta1TaskInput } from './preflight.js'
import {
  r3MandatoryDimensionsRule,
  scopeAcceptanceCoverageRule,
  sourceTestPairingRule,
} from './preflight-rules.js'
import { ACCOUNTABILITY_EVENTS_PATH, ACCOUNTABILITY_GENESIS_DIGEST, normalizeDefectClass } from './policy.js'

export type PermanentGateType = 'preflight-check' | 'post-implementation' | 'review-required'

export interface PermanentGateTrigger {
  sequence: number
  priorTriggerDigest: string | null
  triggerDigest: string
  triggeredAt: string
  taskId: string
  blocked: boolean
}

export interface PermanentGate {
  gateId: string
  defectClass: string
  gateType: PermanentGateType
  rule: string
  installedAt: string
  triggeredBy: { taskId: string; findingId: string; remediationEventDigest: string }
  triggerHistory: PermanentGateTrigger[]
}

export interface PermanentGatesDocument {
  schemaVersion: 1
  artifactType: 'engineering-governance-permanent-gates-v1'
  actorId: string
  gates: PermanentGate[]
  documentDigest: string
}

export interface PermanentGateCheck {
  valid: boolean
  errors: string[]
  triggeredGateIds: string[]
}

const mappings: Record<string, { gateType: PermanentGateType; rule: string }> = {
  'missing-test-file': { gateType: 'preflight-check', rule: 'source-test-pairing' },
  'authority-file-mismatch': { gateType: 'preflight-check', rule: 'authority-completeness' },
  'scope-acceptance-gap': { gateType: 'preflight-check', rule: 'scope-acceptance-coverage' },
  'missing-security-test': { gateType: 'preflight-check', rule: 'r3-mandatory-security' },
  'evidence-forgery': { gateType: 'review-required', rule: 'independent-evidence-verification' },
}

function gatesPath(projectRoot: string, actorId: string): string {
  return join(realpathSync(resolve(projectRoot)), '.delivery', 'accountability', 'permanent-gates', `${normalizeActorId(actorId)}.json`)
}

function withDocumentDigest(input: Omit<PermanentGatesDocument, 'documentDigest'> | PermanentGatesDocument): PermanentGatesDocument {
  const { documentDigest: _previous, ...unsigned } = input as PermanentGatesDocument
  return { ...unsigned, documentDigest: canonicalDigest(unsigned) }
}

type GateSourceEvent = {
  sequence: number
  priorEventDigest: string
  eventDigest: string
  eventType: string
  subjectActorId: string
  source: { taskId: string; findingId: string }
}

function validatedSourceEvents(projectRoot: string): GateSourceEvent[] {
  const path = join(realpathSync(resolve(projectRoot)), ACCOUNTABILITY_EVENTS_PATH)
  if (!existsSync(path) || lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile() || realpathSync(path) !== path) {
    throw new Error('ACCOUNTABILITY_PERMANENT_GATE_EVENT_SOURCE_UNSAFE')
  }
  let decoded: unknown[]
  try { decoded = readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) } catch {
    throw new Error('ACCOUNTABILITY_PERMANENT_GATE_EVENT_SOURCE_INVALID')
  }
  const events: GateSourceEvent[] = []
  for (const [index, value] of decoded.entries()) {
    if (!validateDocument('accountability-event', value).valid) throw new Error('ACCOUNTABILITY_PERMANENT_GATE_EVENT_SOURCE_INVALID')
    const event = value as GateSourceEvent
    const { eventDigest, ...unsigned } = value as GateSourceEvent & Record<string, unknown>
    if (event.sequence !== index + 1
      || event.priorEventDigest !== (events.at(-1)?.eventDigest ?? ACCOUNTABILITY_GENESIS_DIGEST)
      || canonicalDigest(unsigned) !== eventDigest) {
      throw new Error('ACCOUNTABILITY_PERMANENT_GATE_EVENT_SOURCE_INVALID')
    }
    events.push(event)
  }
  return events
}

function validateGateDocument(document: PermanentGatesDocument, actorId: string, projectRoot: string): void {
  if (!validateDocument('permanent-gates', document).valid) throw new Error('ACCOUNTABILITY_PERMANENT_GATES_SCHEMA_INVALID')
  const { documentDigest, ...unsigned } = document
  if (canonicalDigest(unsigned) !== documentDigest) throw new Error('ACCOUNTABILITY_PERMANENT_GATES_DIGEST_INVALID')
  if (document.actorId !== normalizeActorId(actorId)) throw new Error('ACCOUNTABILITY_PERMANENT_GATES_ACTOR_MISMATCH')
  const keys = document.gates.map((gate) => `${gate.defectClass}:${gate.gateType}:${gate.rule}`)
  if (new Set(keys).size !== keys.length) throw new Error('ACCOUNTABILITY_PERMANENT_GATES_DUPLICATED')
  const events = document.gates.length === 0 ? [] : validatedSourceEvents(projectRoot)
  for (const gate of document.gates) {
    const remediationIndex = events.findIndex((event) => event.eventDigest === gate.triggeredBy.remediationEventDigest
      && normalizeActorId(event.subjectActorId) === document.actorId
      && event.source.taskId === gate.triggeredBy.taskId
      && ['calibration_recorded', 'standing_changed'].includes(event.eventType))
    const findingIndex = events.findIndex((event) => event.eventType === 'finding_assessed'
      && normalizeActorId(event.subjectActorId) === document.actorId
      && event.source.findingId === gate.triggeredBy.findingId)
    if (findingIndex < 0 || remediationIndex <= findingIndex) throw new Error('ACCOUNTABILITY_PERMANENT_GATE_PROVENANCE_INVALID')
    let prior: string | null = null
    for (const [index, trigger] of gate.triggerHistory.entries()) {
      const { triggerDigest, ...unsignedTrigger } = trigger
      if (trigger.sequence !== index + 1 || trigger.priorTriggerDigest !== prior || canonicalDigest(unsignedTrigger) !== triggerDigest) {
        throw new Error('ACCOUNTABILITY_PERMANENT_GATE_TRIGGER_CHAIN_INVALID')
      }
      prior = trigger.triggerDigest
    }
  }
}

function emptyDocument(actorId: string): PermanentGatesDocument {
  return withDocumentDigest({
    schemaVersion: 1,
    artifactType: 'engineering-governance-permanent-gates-v1',
    actorId: normalizeActorId(actorId),
    gates: [],
  })
}

export function loadPermanentGates(projectRoot: string, actorId: string): PermanentGatesDocument {
  const path = gatesPath(projectRoot, actorId)
  if (!existsSync(path)) return emptyDocument(actorId)
  if (lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile() || realpathSync(path) !== path) {
    throw new Error('ACCOUNTABILITY_PERMANENT_GATES_UNSAFE')
  }
  let document: PermanentGatesDocument
  try { document = JSON.parse(readFileSync(path, 'utf8')) as PermanentGatesDocument } catch {
    throw new Error('ACCOUNTABILITY_PERMANENT_GATES_JSON_INVALID')
  }
  validateGateDocument(document, actorId, projectRoot)
  return document
}

export function selectPermanentGate(defectClass: string): { gateType: PermanentGateType; rule: string } {
  return mappings[normalizeDefectClass(defectClass)] ?? { gateType: 'review-required', rule: 'enhanced-review' }
}

export function installPermanentGate(input: {
  projectRoot: string
  actorId: string
  defectClass: string
  taskId: string
  findingId: string
  remediationEventDigest: string
  installedAt?: string
  gateType?: PermanentGateType
  rule?: string
}): PermanentGatesDocument {
  const actorId = normalizeActorId(input.actorId)
  const defectClass = normalizeDefectClass(input.defectClass)
  if (!/^[a-z0-9][a-z0-9._-]*$/u.test(input.taskId)) throw new Error('ACCOUNTABILITY_PERMANENT_GATE_TASK_INVALID')
  if (!/^[a-f0-9]{64}$/u.test(input.remediationEventDigest)) throw new Error('ACCOUNTABILITY_PERMANENT_GATE_EVENT_INVALID')
  const current = loadPermanentGates(input.projectRoot, actorId)
  const selected = selectPermanentGate(defectClass)
  const gateType = input.gateType ?? selected.gateType
  const rule = input.rule ?? selected.rule
  const gateKey = { actorId, defectClass, gateType, rule, taskId: input.taskId, findingId: input.findingId }
  const gateId = `pg-${canonicalDigest(gateKey).slice(0, 16)}`
  if (current.gates.some((gate) => gate.gateId === gateId || gate.defectClass === defectClass)) return current
  const gate: PermanentGate = {
    gateId,
    defectClass,
    gateType,
    rule,
    installedAt: input.installedAt ?? new Date().toISOString(),
    triggeredBy: {
      taskId: input.taskId,
      findingId: input.findingId,
      remediationEventDigest: input.remediationEventDigest,
    },
    triggerHistory: [],
  }
  const next = withDocumentDigest({ ...current, gates: [...current.gates, gate].sort((left, right) => left.gateId.localeCompare(right.gateId)) })
  validateGateDocument(next, actorId, input.projectRoot)
  const path = gatesPath(input.projectRoot, actorId)
  mkdirSync(dirname(path), { recursive: true, mode: 0o755 })
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o644 })
  return next
}

export function recordPermanentGateTrigger(input: {
  projectRoot: string
  actorId: string
  gateId: string
  taskId: string
  blocked: boolean
  triggeredAt?: string
}): PermanentGatesDocument {
  const current = loadPermanentGates(input.projectRoot, input.actorId)
  const index = current.gates.findIndex((gate) => gate.gateId === input.gateId)
  if (index < 0) throw new Error('ACCOUNTABILITY_PERMANENT_GATE_NOT_FOUND')
  const gate = current.gates[index]!
  const unsigned = {
    sequence: gate.triggerHistory.length + 1,
    priorTriggerDigest: gate.triggerHistory.at(-1)?.triggerDigest ?? null,
    triggeredAt: input.triggeredAt ?? new Date().toISOString(),
    taskId: input.taskId,
    blocked: input.blocked,
  }
  const trigger = { ...unsigned, triggerDigest: canonicalDigest(unsigned) }
  const gates = current.gates.map((candidate, candidateIndex) => candidateIndex === index
    ? { ...candidate, triggerHistory: [...candidate.triggerHistory, trigger] }
    : candidate)
  const next = withDocumentDigest({ ...current, gates })
  validateGateDocument(next, input.actorId, input.projectRoot)
  writeFileSync(gatesPath(input.projectRoot, input.actorId), `${JSON.stringify(next, null, 2)}\n`, { mode: 0o644 })
  return next
}

function authorityCompletenessErrors(input: Beta1TaskInput): string[] {
  if (!Array.isArray(input.authorityInputs) || input.authorityInputs.length === 0) return ['PERMANENT_GATE_AUTHORITY_INPUTS_MISSING']
  const bindings = typeof input.designBindings === 'object' && input.designBindings !== null
    && Array.isArray((input.designBindings as { authorities?: unknown }).authorities)
    ? (input.designBindings as { authorities: unknown[] }).authorities
    : []
  return input.authorityInputs.length > bindings.length ? ['PERMANENT_GATE_AUTHORITY_BINDINGS_INCOMPLETE'] : []
}

function ruleErrors(rule: string, input: Beta1TaskInput, risk: string): string[] {
  if (rule === 'source-test-pairing') return sourceTestPairingRule(input).errors
  if (rule === 'authority-completeness') return authorityCompletenessErrors(input)
  if (rule === 'scope-acceptance-coverage') return scopeAcceptanceCoverageRule(input).warnings
    .map((warning) => warning.replace('PREFLIGHT_', 'PERMANENT_GATE_'))
  if (rule === 'r3-mandatory-security') return r3MandatoryDimensionsRule(input, risk).errors
    .filter((error) => error.endsWith(':security'))
  return [`ACCOUNTABILITY_PERMANENT_GATE_RULE_UNKNOWN:${rule}`]
}

export function enforcePermanentGates(
  projectRoot: string,
  actorId: string,
  input: Beta1TaskInput,
  risk: string,
): PermanentGateCheck {
  let document: PermanentGatesDocument
  try { document = loadPermanentGates(projectRoot, actorId) } catch (error) {
    return { valid: false, errors: [error instanceof Error ? error.message : 'ACCOUNTABILITY_PERMANENT_GATES_INVALID'], triggeredGateIds: [] }
  }
  const errors: string[] = []
  const triggeredGateIds: string[] = []
  for (const gate of document.gates.filter((candidate) => candidate.gateType === 'preflight-check')) {
    const failures = ruleErrors(gate.rule, input, risk)
    if (failures.length === 0) continue
    triggeredGateIds.push(gate.gateId)
    errors.push(...failures.map((failure) => `PERMANENT_GATE_BLOCKED:${gate.gateId}:${gate.defectClass}:${failure}`))
  }
  return { valid: errors.length === 0, errors, triggeredGateIds }
}

export function hasPermanentGates(projectRoot: string, actorId: string, defectClasses: readonly string[]): boolean {
  const installed = new Set(loadPermanentGates(projectRoot, actorId).gates.map((gate) => gate.defectClass))
  return defectClasses.every((defectClass) => installed.has(normalizeDefectClass(defectClass)))
}
