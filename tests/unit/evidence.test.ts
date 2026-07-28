import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { verifyEvidence } from '../../src/evidence/verify.js'

async function fixture(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(
    new URL('../fixtures/evidence/valid.json', import.meta.url),
    'utf8',
  )) as Record<string, unknown>
}

const options = {
  requiredAcceptanceIds: ['AC-01'],
  expectedContractDigest: 'b'.repeat(64),
  expectedImplementationIdentities: [{
    repository: 'repo',
    commit: 'c'.repeat(40),
    tree: 'd'.repeat(40),
  }],
  requiredEvidenceKinds: { 'AC-01': 'unit' as const },
  expectedRunnerVersion: '1.0.0',
  verificationTime: new Date('2026-07-29T00:05:00Z'),
  maxEvidenceAgeMs: 10 * 60 * 1000,
  artifactRoot: fileURLToPath(new URL('../fixtures/evidence', import.meta.url)),
}

describe('evidence verification', () => {
  it('accepts valid underlying execution evidence', async () => {
    expect(verifyEvidence(await fixture(), options)).toEqual({
      valid: true,
      errors: [],
      passedIds: ['AC-01'],
    })
  })

  it('rejects empty and partial records', async () => {
    const empty = await fixture()
    empty.records = []
    expect(verifyEvidence(empty, options).errors).toContain('EVIDENCE_RECORDS_EMPTY')

    const partial = await fixture()
    delete (partial.records as Array<Record<string, unknown>>)[0]?.rawArtifact
    expect(verifyEvidence(partial, options).errors).toContain('EVIDENCE_RECORD_PARTIAL:AC-01')
  })

  it('rejects duplicated acceptance IDs', async () => {
    const input = await fixture()
    const records = input.records as Array<Record<string, unknown>>
    records.push(structuredClone(records[0]))
    expect(verifyEvidence(input, options).errors).toContain('DUPLICATE_ACCEPTANCE_ID:AC-01')
  })

  it('rejects cross-run and wrong-commit records', async () => {
    const crossRun = await fixture()
    ;(crossRun.records as Array<Record<string, unknown>>)[0]!.runId = 'run-2'
    expect(verifyEvidence(crossRun, options).errors).toContain('CROSS_RUN_RECORD:AC-01')

    const wrongCommit = await fixture()
    ;(wrongCommit.records as Array<Record<string, unknown>>)[0]!.implementationIdentities = [{
      repository: 'repo',
      commit: 'f'.repeat(40),
      tree: 'd'.repeat(40),
    }]
    expect(verifyEvidence(wrongCommit, options).errors).toContain(
      'IMPLEMENTATION_IDENTITY_SET_MISMATCH:AC-01',
    )
  })

  it('rejects a forged summary and evidence-kind substitution', async () => {
    const summary = await fixture()
    summary.summary = { passedIds: [], failedIds: ['AC-01'] }
    expect(verifyEvidence(summary, options).errors).toContain('SUMMARY_MISMATCH')

    const compiledOnly = await fixture()
    ;(compiledOnly.records as Array<Record<string, unknown>>)[0]!.evidenceKind = 'compile'
    expect(verifyEvidence(compiledOnly, options).errors).toContain('EVIDENCE_KIND_MISMATCH:AC-01:unit:compile')
  })

  it('rejects a forged raw-artifact digest', async () => {
    const input = await fixture()
    const records = input.records as Array<{ rawArtifact: { sha256: string } }>
    records[0]!.rawArtifact.sha256 = 'f'.repeat(64)
    expect(verifyEvidence(input, options).errors).toContain('RAW_ARTIFACT_DIGEST_MISMATCH:AC-01')
  })

  it('rejects digest-matching artifacts that do not contain executed check records', async () => {
    const input = await fixture()
    const records = input.records as Array<{
      rawArtifact: { path: string; sha256: string; format: string }
      executedCheckIds: string[]
    }>
    records[0]!.rawArtifact = {
      path: 'artifacts/test.json',
      sha256: 'e5f1eb4d806641698a35efe20e098efd20d7d57a9b90ee69079d5bb650920726',
      format: 'sop-command-execution-v1',
    }
    expect(verifyEvidence(input, options).errors).toContain(
      'RAW_ARTIFACT_FORMAT_UNSUPPORTED:AC-01',
    )

    const wrongIdentity = await fixture()
    ;(wrongIdentity.records as Array<{ executedCheckIds: string[] }>)[0]!.executedCheckIds = [
      'test:forged',
    ]
    expect(verifyEvidence(wrongIdentity, options).errors).toContain(
      'EXECUTED_CHECK_ID_MISMATCH:AC-01',
    )
  })

  it('rejects missing, unexpected, and failed acceptance records', async () => {
    const missingOptions = { ...options, requiredAcceptanceIds: ['AC-01', 'AC-02'] }
    expect(verifyEvidence(await fixture(), missingOptions).errors).toContain('MISSING_ACCEPTANCE_ID:AC-02')

    const unexpectedOptions = { ...options, requiredAcceptanceIds: [] }
    expect(verifyEvidence(await fixture(), unexpectedOptions).errors).toContain('UNEXPECTED_ACCEPTANCE_ID:AC-01')

    const failed = await fixture()
    ;(failed.records as Array<Record<string, unknown>>)[0]!.exitCode = 1
    failed.summary = { passedIds: [], failedIds: ['AC-01'] }
    expect(verifyEvidence(failed, options).errors).toContain('REQUIRED_GATE_FAILED:AC-01')
  })
})
