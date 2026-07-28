import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import { verifyReviewEligibility } from '../../src/commands/task-review.js'
import { verifyEvidence } from '../../src/evidence/verify.js'
import { validateException } from '../../src/policy/exceptions.js'
import { applyPlannedWrites } from '../../src/project/mutate.js'

const fixtureRoot = fileURLToPath(new URL('../fixtures/evidence', import.meta.url))
const temporaryDirectories: string[] = []

async function fixture(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(
    new URL('../fixtures/evidence/valid.json', import.meta.url),
    'utf8',
  )) as Record<string, unknown>
}

function options(requiredAcceptanceIds = ['AC-01']) {
  return {
    requiredAcceptanceIds,
    expectedContractDigest: 'b'.repeat(64),
    expectedImplementationIdentities: { repo: 'c'.repeat(40) },
    requiredEvidenceKinds: Object.fromEntries(
      requiredAcceptanceIds.map((id) => [id, 'unit' as const]),
    ),
    expectedRunnerVersion: '1.0.0',
    verificationTime: new Date('2026-07-29T00:05:00Z'),
    maxEvidenceAgeMs: 10 * 60 * 1000,
    artifactRoot: fixtureRoot,
  }
}

function errors(input: unknown, requiredAcceptanceIds = ['AC-01']): string[] {
  return verifyEvidence(input, options(requiredAcceptanceIds)).errors
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async (path) => rm(path, {
    recursive: true,
    force: true,
  })))
})

describe('adversarial workflow rejection codes', () => {
  it('rejects omitted, empty, duplicated, reordered, and partial records', async () => {
    const omitted = await fixture()
    expect(errors(omitted, ['AC-01', 'AC-02'])).toContain('MISSING_ACCEPTANCE_ID:AC-02')

    const empty = await fixture()
    empty.records = []
    expect(errors(empty)).toContain('EVIDENCE_RECORDS_EMPTY')

    const duplicated = await fixture()
    const duplicatedRecords = duplicated.records as Array<Record<string, unknown>>
    duplicatedRecords.push(structuredClone(duplicatedRecords[0]))
    expect(errors(duplicated)).toContain('DUPLICATE_ACCEPTANCE_ID:AC-01')

    const reordered = await fixture()
    const first = (reordered.records as Array<Record<string, unknown>>)[0]!
    const second = structuredClone(first)
    second.acceptanceId = 'AC-02'
    second.executedCheckIds = ['test:ac-02']
    reordered.records = [second, first]
    reordered.summary = { passedIds: ['AC-01', 'AC-02'], failedIds: [] }
    expect(errors(reordered, ['AC-01', 'AC-02'])).toContain('RECORD_ORDER_MISMATCH')

    const partial = await fixture()
    delete (partial.records as Array<Record<string, unknown>>)[0]!.rawArtifact
    expect(errors(partial)).toContain('EVIDENCE_RECORD_PARTIAL:AC-01')
  })

  it('rejects cross-run, stale, forged, wrong-commit, and compile-only evidence', async () => {
    const crossRun = await fixture()
    ;(crossRun.records as Array<Record<string, unknown>>)[0]!.runId = 'run-other'
    expect(errors(crossRun)).toContain('CROSS_RUN_RECORD:AC-01')

    const stale = await fixture()
    ;(stale.records as Array<Record<string, unknown>>)[0]!.endedAt = '2026-07-28T23:00:00Z'
    expect(errors(stale)).toContain('STALE_EVIDENCE:AC-01')

    const forged = await fixture()
    const forgedRecord = (forged.records as Array<{
      rawArtifact: { sha256: string }
    }>)[0]!
    forgedRecord.rawArtifact.sha256 = 'f'.repeat(64)
    expect(errors(forged)).toContain('RAW_ARTIFACT_DIGEST_MISMATCH:AC-01')

    const wrongCommit = await fixture()
    ;(wrongCommit.records as Array<Record<string, unknown>>)[0]!.implementationIdentities = {
      repo: 'f'.repeat(40),
    }
    expect(errors(wrongCommit)).toContain('IMPLEMENTATION_IDENTITY_MISMATCH:AC-01:repo')

    const compiledOnly = await fixture()
    ;(compiledOnly.records as Array<Record<string, unknown>>)[0]!.evidenceKind = 'compile'
    expect(errors(compiledOnly)).toContain('EVIDENCE_KIND_MISMATCH:AC-01:unit:compile')
  })

  it('rejects missing runners, expired exceptions, and self-review for R2', async () => {
    const missingRunner = await fixture()
    delete missingRunner.runnerVersion
    expect(errors(missingRunner)).toContain('RUNNER_VERSION_MISSING')

    expect(validateException({
      ruleId: 'WAIVER-1',
      ruleClass: 'waiverable',
      scope: ['gate:test'],
      approvedBy: 'user',
      issuedAt: '2026-07-28T00:00:00Z',
      expiresAt: '2026-07-29T00:00:00Z',
      status: 'active',
      compensatingControls: ['manual review'],
    }, new Date('2026-07-29T00:00:01Z')).errors).toContain('EXCEPTION_EXPIRED')

    expect(verifyReviewEligibility({
      risk: 'R2',
      implementationOwner: 'agent-a',
      reviewOwner: 'agent-a',
      blockingFindingIds: [],
    }).errors).toContain('INDEPENDENT_REVIEW_REQUIRED')
  })

  it('rejects a managed-file overlap without changing the newer content', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sop-dirty-overlap-'))
    temporaryDirectories.push(directory)
    const path = join(directory, 'AGENTS.md')
    await writeFile(path, 'planned base\n')
    const beforeDigest = createHash('sha256').update('planned base\n').digest('hex')
    await writeFile(path, 'new user edit\n')

    expect(() => applyPlannedWrites([{
      path,
      beforeDigest,
      after: 'managed result\n',
    }], { dryRun: false })).toThrow(`MANAGED_FILE_CHANGED:${path}`)
    await expect(readFile(path, 'utf8')).resolves.toBe('new user edit\n')
  })
})
