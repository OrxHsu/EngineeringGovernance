import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'

import { validateDocument } from '../policy/load.js'
import { canonicalDigest } from '../model/digest.js'
import { commandCheckId, type ExactCommand } from './capture.js'

export type EvidenceKind =
  | 'static'
  | 'compile'
  | 'unit'
  | 'integration'
  | 'device'
  | 'cloud'
  | 'production'

export interface ImplementationIdentity {
  repository: string
  commit: string
  tree: string
}

type EvidenceCommand = ExactCommand

interface EvidenceRecord {
  acceptanceId: string
  runId: string
  executedCheckIds: string[]
  command: EvidenceCommand
  exitCode: number
  startedAt: string
  endedAt: string
  evidenceKind: EvidenceKind
  implementationIdentities: ImplementationIdentity[]
  rawArtifact: { path: string; sha256: string; format: 'sop-command-execution-v1' }
  observation: string
}

interface EvidenceDocument {
  schemaVersion: 1
  taskId: string
  contractDigest: string
  runId: string
  runnerVersion: string
  implementationCommits: ImplementationIdentity[]
  records: EvidenceRecord[]
  summary: { passedIds: string[]; failedIds: string[] }
}

interface RawExecutionArtifact {
  schemaVersion: 1
  artifactType: 'sop-command-execution-v1'
  producer: { name: '@xgh/engineering-governance'; version: string }
  runId: string
  command: EvidenceCommand
  startedAt: string
  endedAt: string
  exitCode: number
  environment: { node: string; platform: string; arch: string }
  checks: Array<{ id: string; status: 'passed' | 'failed' }>
  stdout: string
  stderr: string
}

export interface EvidenceVerificationOptions {
  requiredAcceptanceIds: string[]
  expectedContractDigest: string
  expectedImplementationIdentities: ImplementationIdentity[]
  requiredEvidenceKinds: Record<string, EvidenceKind>
  expectedRunnerVersion: string
  verificationTime: Date
  maxEvidenceAgeMs: number
  artifactRoot: string
  approvedReplayPlanDigest?: string
  commandExecutor?: (command: EvidenceCommand) => {
    exitCode: number
    stdout: string
    stderr: string
  }
}

export function evidenceReplayPlanDigest(
  records: Array<{ acceptanceId: string; command: EvidenceCommand }>,
): string {
  return canonicalDigest(records.map((record) => ({
    acceptanceId: record.acceptanceId,
    command: record.command,
  })))
}

export interface EvidenceDecision {
  valid: boolean
  errors: string[]
  passedIds: string[]
}

function canonical(values: string[]): string[] {
  return [...new Set(values)].sort()
}

function sameStrings(left: string[], right: string[]): boolean {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right))
}

function canonicalIdentities(values: ImplementationIdentity[]): ImplementationIdentity[] {
  return [...values].sort((left, right) => left.repository.localeCompare(right.repository))
}

function sameIdentities(left: ImplementationIdentity[], right: ImplementationIdentity[]): boolean {
  return JSON.stringify(canonicalIdentities(left)) === JSON.stringify(canonicalIdentities(right))
}

const evidenceRecordKeys = [
  'acceptanceId',
  'runId',
  'executedCheckIds',
  'command',
  'exitCode',
  'startedAt',
  'endedAt',
  'evidenceKind',
  'implementationIdentities',
  'rawArtifact',
  'observation',
] as const

function preflightEvidence(input: unknown): string[] {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return []
  const document = input as Record<string, unknown>
  if (!Object.hasOwn(document, 'runnerVersion') || document.runnerVersion === '') {
    return ['RUNNER_VERSION_MISSING']
  }
  if (!Object.hasOwn(document, 'records')) return ['EVIDENCE_RECORDS_MISSING']
  if (Array.isArray(document.records)) {
    if (document.records.length === 0) return ['EVIDENCE_RECORDS_EMPTY']
    const partial = document.records.findIndex((candidate) => {
      if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
        return true
      }
      return evidenceRecordKeys.some((key) => !Object.hasOwn(candidate, key))
    })
    if (partial >= 0) {
      const candidate = document.records[partial]
      const acceptanceId = typeof candidate === 'object' && candidate !== null
        && 'acceptanceId' in candidate && typeof candidate.acceptanceId === 'string'
        ? candidate.acceptanceId
        : `index-${partial}`
      return [`EVIDENCE_RECORD_PARTIAL:${acceptanceId}`]
    }
  }
  return []
}

function executeCommand(command: EvidenceCommand): {
  exitCode: number
  stdout: string
  stderr: string
} {
  const result = spawnSync(command.executable, command.arguments, {
    cwd: command.cwd,
    encoding: 'utf8',
    env: process.env,
    maxBuffer: 64 * 1024 * 1024,
    shell: false,
  })
  return {
    exitCode: result.status ?? 70,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? result.error?.message ?? '',
  }
}

function verifyRawArtifact(
  record: EvidenceRecord,
  artifactRoot: string,
  expectedRunnerVersion: string,
  commandExecutor: EvidenceVerificationOptions['commandExecutor'],
): string[] {
  const errors: string[] = []
  try {
    const realRoot = realpathSync(artifactRoot)
    const candidate = realpathSync(resolve(realRoot, record.rawArtifact.path))
    const relativePath = relative(realRoot, candidate)
    if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
      return [`RAW_ARTIFACT_OUTSIDE_ROOT:${record.acceptanceId}`]
    }

    const raw = readFileSync(candidate)
    const digest = createHash('sha256').update(raw).digest('hex')
    if (digest !== record.rawArtifact.sha256) {
      return [`RAW_ARTIFACT_DIGEST_MISMATCH:${record.acceptanceId}`]
    }

    let artifact: RawExecutionArtifact
    try {
      artifact = JSON.parse(raw.toString('utf8')) as RawExecutionArtifact
    } catch {
      return [`RAW_ARTIFACT_FORMAT_INVALID:${record.acceptanceId}`]
    }
    if (artifact.artifactType !== 'sop-command-execution-v1') {
      return [`RAW_ARTIFACT_FORMAT_UNSUPPORTED:${record.acceptanceId}`]
    }
    if (
      artifact.schemaVersion !== 1
      || artifact.producer?.name !== '@xgh/engineering-governance'
      || artifact.producer.version !== expectedRunnerVersion
      || typeof artifact.runId !== 'string'
      || typeof artifact.command?.executable !== 'string'
      || !Array.isArray(artifact.command.arguments)
      || artifact.command.arguments.some((argument) => typeof argument !== 'string')
      || typeof artifact.command.cwd !== 'string'
      || typeof artifact.startedAt !== 'string'
      || typeof artifact.endedAt !== 'string'
      || !Number.isInteger(artifact.exitCode)
      || typeof artifact.environment?.node !== 'string'
      || typeof artifact.environment.platform !== 'string'
      || typeof artifact.environment.arch !== 'string'
      || !Array.isArray(artifact.checks)
      || artifact.checks.length !== 1
      || artifact.checks.some((check) => (
        typeof check !== 'object'
        || check === null
        || typeof check.id !== 'string'
        || check.id.length === 0
        || (check.status !== 'passed' && check.status !== 'failed')
      ))
      || new Set(artifact.checks.map((check) => check.id)).size !== artifact.checks.length
      || typeof artifact.stdout !== 'string'
      || typeof artifact.stderr !== 'string'
    ) {
      return [`RAW_ARTIFACT_FORMAT_INVALID:${record.acceptanceId}`]
    }
    if (!/^22\./u.test(artifact.environment.node)) {
      return [`RAW_ARTIFACT_NODE_UNSUPPORTED:${record.acceptanceId}`]
    }
    if (artifact.stdout.length === 0 && artifact.stderr.length === 0) {
      return [`RAW_ARTIFACT_OUTPUT_EMPTY:${record.acceptanceId}`]
    }
    if (artifact.runId !== record.runId) {
      return [`RAW_ARTIFACT_RUN_MISMATCH:${record.acceptanceId}`]
    }
    if (JSON.stringify(artifact.command) !== JSON.stringify(record.command)) {
      return [`RAW_ARTIFACT_COMMAND_MISMATCH:${record.acceptanceId}`]
    }
    if (
      artifact.startedAt !== record.startedAt
      || artifact.endedAt !== record.endedAt
      || artifact.exitCode !== record.exitCode
    ) {
      return [`RAW_ARTIFACT_EXECUTION_MISMATCH:${record.acceptanceId}`]
    }
    const expectedCheckId = commandCheckId(record.command)
    if (
      record.executedCheckIds.length !== 1
      || record.executedCheckIds[0] !== expectedCheckId
      || artifact.checks[0]?.id !== expectedCheckId
    ) {
      errors.push(`EXECUTED_CHECK_ID_MISMATCH:${record.acceptanceId}`)
    }
    if (
      artifact.checks[0]?.status !== (record.exitCode === 0 ? 'passed' : 'failed')
    ) {
      errors.push(`RAW_EXECUTION_CHECK_STATUS_MISMATCH:${record.acceptanceId}`)
    }
    if (commandExecutor !== undefined) {
      const replay = commandExecutor(record.command)
      if (replay.exitCode !== 0) {
        errors.push(`RAW_EXECUTION_REPLAY_FAILED:${record.acceptanceId}:${replay.exitCode}`)
      }
    }
    return errors
  } catch {
    return [`RAW_ARTIFACT_MISSING:${record.acceptanceId}`]
  }
}

export function verifyEvidence(
  input: unknown,
  options: EvidenceVerificationOptions,
): EvidenceDecision {
  const preflightErrors = preflightEvidence(input)
  if (preflightErrors.length > 0) {
    return { valid: false, errors: preflightErrors, passedIds: [] }
  }
  const schema = validateDocument('evidence', input)
  if (!schema.valid) {
    return {
      valid: false,
      errors: schema.errors.map((error) => `SCHEMA_INVALID:${error}`),
      passedIds: [],
    }
  }

  const evidence = input as EvidenceDocument
  const errors: string[] = []
  const seen = new Set<string>()
  const required = new Set(options.requiredAcceptanceIds)
  if (
    new Set(evidence.implementationCommits.map((identity) => identity.repository)).size
    !== evidence.implementationCommits.length
  ) {
    errors.push('IMPLEMENTATION_IDENTITIES_DUPLICATED')
  }
  if (!sameIdentities(evidence.implementationCommits, options.expectedImplementationIdentities)) {
    errors.push('IMPLEMENTATION_IDENTITY_SET_MISMATCH')
  }

  if (evidence.contractDigest !== options.expectedContractDigest) {
    errors.push('CONTRACT_DIGEST_MISMATCH')
  }
  if (evidence.runnerVersion !== options.expectedRunnerVersion) {
    errors.push('RUNNER_VERSION_MISMATCH')
  }

  const replayPlanDigest = evidenceReplayPlanDigest(evidence.records)
  const replayApproved = options.approvedReplayPlanDigest === replayPlanDigest
  if (!replayApproved) {
    errors.push(`EVIDENCE_REPLAY_APPROVAL_REQUIRED:${replayPlanDigest}`)
  }

  const recordOrder = evidence.records.map((record) => record.acceptanceId)
  if (JSON.stringify(recordOrder) !== JSON.stringify(options.requiredAcceptanceIds)) {
    errors.push('RECORD_ORDER_MISMATCH')
  }

  for (const record of evidence.records) {
    if (seen.has(record.acceptanceId)) {
      errors.push(`DUPLICATE_ACCEPTANCE_ID:${record.acceptanceId}`)
    }
    seen.add(record.acceptanceId)

    if (!required.has(record.acceptanceId)) {
      errors.push(`UNEXPECTED_ACCEPTANCE_ID:${record.acceptanceId}`)
    }
    if (record.runId !== evidence.runId) {
      errors.push(`CROSS_RUN_RECORD:${record.acceptanceId}`)
    }
    if (Date.parse(record.startedAt) > Date.parse(record.endedAt)) {
      errors.push(`INVALID_EXECUTION_TIME_RANGE:${record.acceptanceId}`)
    }
    if (!Number.isFinite(Date.parse(record.startedAt)) || !Number.isFinite(Date.parse(record.endedAt))) {
      errors.push(`INVALID_EXECUTION_TIMESTAMP:${record.acceptanceId}`)
    }
    const endedAt = Date.parse(record.endedAt)
    const age = options.verificationTime.getTime() - endedAt
    if (Number.isFinite(endedAt) && age > options.maxEvidenceAgeMs) {
      errors.push(`STALE_EVIDENCE:${record.acceptanceId}`)
    }
    if (Number.isFinite(endedAt) && age < 0) {
      errors.push(`EVIDENCE_TIME_IN_FUTURE:${record.acceptanceId}`)
    }
    if (record.exitCode !== 0) {
      errors.push(`REQUIRED_GATE_FAILED:${record.acceptanceId}`)
    }

    errors.push(...verifyRawArtifact(
      record,
      options.artifactRoot,
      options.expectedRunnerVersion,
      replayApproved ? (options.commandExecutor ?? executeCommand) : undefined,
    ))

    const requiredKind = options.requiredEvidenceKinds[record.acceptanceId]
    if (requiredKind && record.evidenceKind !== requiredKind) {
      errors.push(
        `EVIDENCE_KIND_MISMATCH:${record.acceptanceId}:${requiredKind}:${record.evidenceKind}`,
      )
    }

    if (!sameIdentities(record.implementationIdentities, options.expectedImplementationIdentities)) {
      errors.push(`IMPLEMENTATION_IDENTITY_SET_MISMATCH:${record.acceptanceId}`)
    }
    if (
      new Set(record.implementationIdentities.map((identity) => identity.repository)).size
      !== record.implementationIdentities.length
    ) {
      errors.push(`IMPLEMENTATION_IDENTITIES_DUPLICATED:${record.acceptanceId}`)
    }
  }

  for (const acceptanceId of required) {
    if (!seen.has(acceptanceId)) errors.push(`MISSING_ACCEPTANCE_ID:${acceptanceId}`)
  }

  const passedIds = canonical(
    evidence.records
      .filter((record) => record.exitCode === 0)
      .map((record) => record.acceptanceId),
  )
  const failedIds = canonical(
    evidence.records
      .filter((record) => record.exitCode !== 0)
      .map((record) => record.acceptanceId),
  )
  if (
    !sameStrings(evidence.summary.passedIds, passedIds)
    || !sameStrings(evidence.summary.failedIds, failedIds)
  ) {
    errors.push('SUMMARY_MISMATCH')
  }

  const uniqueErrors = canonical(errors)
  return { valid: uniqueErrors.length === 0, errors: uniqueErrors, passedIds }
}
