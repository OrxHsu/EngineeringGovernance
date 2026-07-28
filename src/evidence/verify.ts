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
  implementationCommits: ImplementationCommit[]
  records: EvidenceRecord[]
  summary: { passedIds: string[]; failedIds: string[] }
}

export interface EvidenceVerificationOptions {
  requiredAcceptanceIds: string[]
  expectedContractDigest: string
  expectedImplementationIdentities: Record<string, string>
  requiredEvidenceKinds: Record<string, EvidenceKind>
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

    const digest = createHash('sha256').update(readFileSync(candidate)).digest('hex')
    if (digest !== record.rawArtifact.sha256) {
      return `RAW_ARTIFACT_DIGEST_MISMATCH:${record.acceptanceId}`
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
