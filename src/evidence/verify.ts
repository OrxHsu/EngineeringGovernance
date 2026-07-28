import { createHash } from 'node:crypto'
import { readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'

import { validateDocument } from '../policy/load.js'

export type EvidenceKind =
  | 'static'
  | 'compile'
  | 'unit'
  | 'integration'
  | 'device'
  | 'cloud'
  | 'production'

interface ImplementationCommit {
  repository: string
  commit: string
  tree: string
}

interface EvidenceRecord {
  acceptanceId: string
  runId: string
  executedCheckIds: string[]
  command: string
  exitCode: number
  startedAt: string
  endedAt: string
  evidenceKind: EvidenceKind
  implementationIdentities: Record<string, string>
  rawArtifact: { path: string; sha256: string }
  observation: string
}

interface EvidenceDocument {
  schemaVersion: 1
  taskId: string
  contractDigest: string
  runId: string
  runnerVersion: string
  implementationCommits: ImplementationCommit[]
  records: EvidenceRecord[]
  summary: { passedIds: string[]; failedIds: string[] }
}

interface RawExecutionArtifact {
  schemaVersion: 1
  runId: string
  checks: Array<{ id: string; status: 'passed' | 'failed' }>
}

export interface EvidenceVerificationOptions {
  requiredAcceptanceIds: string[]
  expectedContractDigest: string
  expectedImplementationIdentities: Record<string, string>
  requiredEvidenceKinds: Record<string, EvidenceKind>
  expectedRunnerVersion: string
  verificationTime: Date
  maxEvidenceAgeMs: number
  artifactRoot: string
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

function verifyRawArtifact(
  record: EvidenceRecord,
  artifactRoot: string,
): string | undefined {
  try {
    const realRoot = realpathSync(artifactRoot)
    const candidate = realpathSync(resolve(realRoot, record.rawArtifact.path))
    const relativePath = relative(realRoot, candidate)
    if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
      return `RAW_ARTIFACT_OUTSIDE_ROOT:${record.acceptanceId}`
    }

    const raw = readFileSync(candidate)
    const digest = createHash('sha256').update(raw).digest('hex')
    if (digest !== record.rawArtifact.sha256) {
      return `RAW_ARTIFACT_DIGEST_MISMATCH:${record.acceptanceId}`
    }

    let artifact: RawExecutionArtifact
    try {
      artifact = JSON.parse(raw.toString('utf8')) as RawExecutionArtifact
    } catch {
      return `RAW_ARTIFACT_FORMAT_INVALID:${record.acceptanceId}`
    }
    if (
      artifact.schemaVersion !== 1
      || typeof artifact.runId !== 'string'
      || !Array.isArray(artifact.checks)
      || artifact.checks.length === 0
      || artifact.checks.some((check) => (
        typeof check !== 'object'
        || check === null
        || typeof check.id !== 'string'
        || check.id.length === 0
        || (check.status !== 'passed' && check.status !== 'failed')
      ))
      || new Set(artifact.checks.map((check) => check.id)).size !== artifact.checks.length
    ) {
      return `RAW_ARTIFACT_FORMAT_INVALID:${record.acceptanceId}`
    }
    if (artifact.runId !== record.runId) {
      return `RAW_ARTIFACT_RUN_MISMATCH:${record.acceptanceId}`
    }
    if (!sameStrings(artifact.checks.map((check) => check.id), record.executedCheckIds)) {
      return `EXECUTED_CHECK_ID_MISMATCH:${record.acceptanceId}`
    }
    if (
      record.exitCode === 0
      && artifact.checks.some((check) => check.status !== 'passed')
    ) {
      return `RAW_EXECUTION_CHECK_FAILED:${record.acceptanceId}`
    }
    return undefined
  } catch {
    return `RAW_ARTIFACT_MISSING:${record.acceptanceId}`
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
  const topLevelIdentities = Object.fromEntries(
    evidence.implementationCommits.map((item) => [item.repository, item.commit]),
  )

  if (evidence.contractDigest !== options.expectedContractDigest) {
    errors.push('CONTRACT_DIGEST_MISMATCH')
  }
  if (evidence.runnerVersion !== options.expectedRunnerVersion) {
    errors.push('RUNNER_VERSION_MISMATCH')
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

    const artifactError = verifyRawArtifact(record, options.artifactRoot)
    if (artifactError) errors.push(artifactError)

    const requiredKind = options.requiredEvidenceKinds[record.acceptanceId]
    if (requiredKind && record.evidenceKind !== requiredKind) {
      errors.push(
        `EVIDENCE_KIND_MISMATCH:${record.acceptanceId}:${requiredKind}:${record.evidenceKind}`,
      )
    }

    for (const [repository, commit] of Object.entries(options.expectedImplementationIdentities)) {
      if (
        topLevelIdentities[repository] !== commit
        || record.implementationIdentities[repository] !== commit
      ) {
        errors.push(`IMPLEMENTATION_IDENTITY_MISMATCH:${record.acceptanceId}:${repository}`)
      }
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
