import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

import { validateDocument } from '../../src/policy/load.js'

describe('release record schemas', () => {
  it('rejects unknown and missing fields in the prior finding record', () => {
    const valid = {
      schemaVersion: 1,
      artifactType: 'engineering-governance-prior-review-finding-v1',
      recordId: 'prior-finding',
      reviewedImplementation: { repository: 'repo', commit: 'a'.repeat(40), tree: 'b'.repeat(40) },
      reporter: { id: 'reviewer', trustLevel: 'local-claim' },
      decision: 'REPAIR_REQUIRED', acceptanceStatus: 'not-accepted',
      finding: { id: 'P1', severity: 'BLOCKER', classification: 'newly_discovered_defect', observation: 'x', requiredChange: 'y' },
      reproduction: { input: 'schemaVersion: 2', failure: 'TypeError' }, recordedAt: '2026-08-15T00:00:00Z',
    }
    expect(validateDocument('prior-review-finding', valid).valid).toBe(true)
    expect(validateDocument('prior-review-finding', { ...valid, extra: true }).valid).toBe(false)
    expect(validateDocument('prior-review-finding', { ...valid, finding: undefined }).valid).toBe(false)
  })

  it('requires an archive verification receipt bound to the release record', () => {
    const receipt = {
      path: 'releases/2.1.0/archive-verification.json', rawSha256: 'a'.repeat(64), digest: 'b'.repeat(64),
      archivePath: '/tmp/engineering-governance-2.1.0.tgz', sha256: 'c'.repeat(64), firstBuildSha256: 'c'.repeat(64), secondBuildSha256: 'c'.repeat(64),
      candidateCommit: 'd'.repeat(40), candidateTree: 'e'.repeat(40), version: '2.1.0', identical: true,
    }
    const record = {
      schemaVersion: 1, artifactType: 'engineering-governance-release-record-v1', taskId: 'release-task',
      contract: { path: '.delivery/tasks/release-task/contract.yaml', rawSha256: 'f'.repeat(64), digest: '0'.repeat(64) },
      sourceRange: { baseCommit: '1'.repeat(40), baseTree: '2'.repeat(40), commits: [{ commit: 'd'.repeat(40), tree: 'e'.repeat(40) }], candidateCommit: 'd'.repeat(40), candidateTree: 'e'.repeat(40) },
      archive: { filename: 'engineering-governance-2.1.0.tgz', path: receipt.archivePath, sha256: receipt.sha256, version: receipt.version, verificationReceipt: receipt },
      sourceIdentity: { packageVersion: '2.1.0', versionFile: '2.1.0' }, publicationStatus: 'local-unpublished',
      priorFinding: { path: 'releases/2.1.0/implementation-review.yaml', rawSha256: '1'.repeat(64), digest: '2'.repeat(64) },
    }
    expect(validateDocument('release-record', record).valid).toBe(true)
    const drifted = structuredClone(record)
    drifted.archive.verificationReceipt.sha256 = '9'.repeat(64)
    expect(validateDocument('release-record', drifted).valid).toBe(true)
    expect(drifted.archive.verificationReceipt.sha256).not.toBe(drifted.archive.sha256)
  })

  it('ships the canonical prior-finding record with the candidate', () => {
    const record = parse(readFileSync('releases/sop-2.1.0-release-v1/prior-finding.yaml', 'utf8'))
    expect(validateDocument('prior-review-finding', record).valid).toBe(true)
  })
})
