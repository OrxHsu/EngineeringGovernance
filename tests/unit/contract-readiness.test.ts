import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import { parse, stringify } from 'yaml'

import { startTask } from '../../src/commands/task-start.js'
import { canonicalDigest } from '../../src/model/digest.js'
import { validateProjectTaskGraph } from '../../src/project/task-graph.js'
import { applyTaskTransition, planTaskTransition } from '../../src/state/ledger.js'
import { verifyContractReadinessArtifact } from '../../src/state/contract-readiness.js'
import { generateReviewSummary } from '../../src/commands/task-review-summary.js'
import { buildContractReviewRequest } from '../../src/review/contract-review-assist.js'
import { SELF_REVIEW_DIMENSIONS } from '../../src/review/mutual-review.js'

const temporaryDirectories: string[] = []

function sha256(input: string | Uint8Array): string {
  return createHash('sha256').update(input).digest('hex')
}

function fixture(): { root: string; taskId: string; contract: Record<string, unknown>; reviewPath: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'sop-contract-readiness-')))
  temporaryDirectories.push(root)
  execFileSync('git', ['-C', root, 'init', '-b', 'main'])
  execFileSync('git', ['-C', root, 'config', 'user.email', 'test@example.com'])
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Test'])
  writeFileSync(join(root, 'authority.md'), 'authority\n')
  execFileSync('git', ['-C', root, 'add', 'authority.md'])
  execFileSync('git', ['-C', root, 'commit', '-m', 'baseline'])
  const taskId = 'readiness-task'
  const result = startTask({
    schemaVersion: 2,
    taskId,
    implementationOwner: 'codex',
    objective: 'Validate pre-implementation readiness.',
    scope: ['src/**'],
    nonGoals: ['deployment'],
    authorityInputs: ['authority.md'],
    repositories: [{ id: 'root', path: root }],
    acceptance: [{
      id: 'AC-01', observation: 'The gate is validated.', positiveCases: ['pass'], negativeCases: ['reject'],
      evidenceKind: 'unit', command: {
        repositoryId: 'root', cwd: '.', executable: process.execPath, arguments: ['--version'],
      }, observerPolicy: { expectedExitCode: 0, output: 'nonempty', checkoutMutation: 'forbidden', replay: 'required' },
    }],
    authorizationRequirements: [],
    openChoices: [],
    signals: { crossModule: true, classificationComplete: true },
  })
  for (const artifact of result.artifacts) {
    const path = join(root, artifact.path)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, artifact.content)
  }
  const contractPath = join(root, `.delivery/tasks/${taskId}/contract.yaml`)
  const contractRaw = readFileSync(contractPath)
  const contract = parse(contractRaw.toString('utf8')) as Record<string, unknown>
  const evidenceRef = { id: 'E-001', kind: 'contract', path: `.delivery/tasks/${taskId}/contract.yaml`, sha256: sha256(contractRaw), digest: canonicalDigest(contract) }
  const item = { status: 'PASS', evidenceRefs: [evidenceRef] }
  const r3Item = { status: 'NA', applicabilityReason: 'risk-below-r3', evidenceRefs: [evidenceRef] }
  const review = {
    schemaVersion: 2,
    artifactType: 'sop-contract-review-v2',
    reviewId: `crv-${taskId}-${String(contract.contractDigest)}`,
    taskId,
    risk: 'R2',
    reviewer: { id: 'independent-reviewer', trustLevel: 'local-claim' },
    decision: 'ACCEPTED',
    contract: { path: contractPath, rawSha256: sha256(contractRaw), digest: contract.contractDigest },
    checklist: {
      scope_non_goals: item, authority_dependencies: item, risk_owner_reviewer: item,
      behavior_state_transitions: item, security_trust: item, evidence_environment: item,
      external_source_provenance: item, rollout_recovery_compatibility: item,
      unresolved_product_decisions: item,
    },
    r3Requirements: {
      trust_threat_analysis: r3Item, migration_recovery_rollback: r3Item,
      specialized_gates: r3Item, scoped_authorization: r3Item, production_observation: r3Item,
    },
    findings: [], nextStage: 'implementation', userActionRequired: false,
  }
  const reviewPath = join(root, `.delivery/tasks/${taskId}/contract-review.yaml`)
  writeFileSync(reviewPath, stringify(review))
  return { root, taskId, contract, reviewPath }
}

function mutualReviewFixture(): ReturnType<typeof fixture> {
  const result = fixture()
  const contractPath = join(result.root, `.delivery/tasks/${result.taskId}/contract.yaml`)
  const contract = parse(readFileSync(contractPath, 'utf8')) as Record<string, any>
  const selfReviewSubjectDigest = 'a'.repeat(64)
  const preflightUnsigned = {
    schemaVersion: 1,
    artifactType: 'engineering-governance-contract-preflight-v1',
    taskId: result.taskId,
    projectRoot: result.root,
    policyVersion: contract.sopVersion,
    policyDigest: contract.policyDigest,
    inputRawSha256: 'b'.repeat(64),
    inputSemanticDigest: 'c'.repeat(64),
    contractSemanticDigest: 'd'.repeat(64),
    repositoryBaselines: contract.repositories.map((repository: Record<string, any>) => ({
      id: repository.id,
      path: repository.path,
      head: repository.baseline.head,
      tree: repository.baseline.tree,
      checkoutDigest: repository.baseline.checkoutDigest,
    })),
    checks: Array.from({ length: 14 }, (_, index) => ({ id: `check-${index}`, status: 'PASS', evidenceRefs: ['input.yaml'] })),
    selfReviewSubjectDigest,
  }
  contract.contractAuthor = 'contract-author'
  contract.contractPreflight = { ...preflightUnsigned, planDigest: canonicalDigest(preflightUnsigned) }
  contract.designBindings = {}
  contract.predecessors = []
  contract.selfReview = {
    schemaVersion: 1,
    artifactType: 'engineering-governance-self-review-v1',
    reviewId: `srv-${result.taskId}-${selfReviewSubjectDigest}`,
    taskId: result.taskId,
    author: 'contract-author',
    subjectDigest: selfReviewSubjectDigest,
    reviewedAt: '2026-08-16T00:00:00.000Z',
    durationSeconds: 30,
    attemptCount: 1,
    effort: 'medium',
    dimensions: SELF_REVIEW_DIMENSIONS.map((name) => ({ name, status: 'PASS', evidence: `${name} is covered.` })),
    overallStatus: 'PASSED',
  }
  contract.knownIssues = []
  contract.contractReadiness.gateVersion = '2.1.0'
  delete contract.contractDigest
  contract.contractDigest = canonicalDigest(contract)
  writeFileSync(contractPath, stringify(contract))

  const contractRaw = readFileSync(contractPath)
  const evidenceRef = { id: 'E-001', kind: 'contract', path: `.delivery/tasks/${result.taskId}/contract.yaml`, sha256: sha256(contractRaw), digest: canonicalDigest(contract) }
  const item = { status: 'PASS', evidenceRefs: [evidenceRef] }
  const r3Item = { status: 'NA', applicabilityReason: 'risk-below-r3', evidenceRefs: [evidenceRef] }
  const assistedItem = { status: 'PASS', observation: 'The exact contract evidence satisfies this dimension.', evidenceRefs: [evidenceRef] }
  const review = {
    schemaVersion: 2,
    artifactType: 'sop-contract-review-v2',
    reviewId: `crv-${result.taskId}-${contract.contractDigest}`,
    taskId: result.taskId,
    risk: 'R2',
    reviewer: { id: 'independent-reviewer', trustLevel: 'local-claim' },
    decision: 'ACCEPTED',
    contract: { path: contractPath, rawSha256: sha256(contractRaw), digest: contract.contractDigest },
    checklist: {
      scope_non_goals: item, authority_dependencies: item, risk_owner_reviewer: item,
      behavior_state_transitions: item, security_trust: item, evidence_environment: item,
      external_source_provenance: item, rollout_recovery_compatibility: item,
      unresolved_product_decisions: item,
    },
    r3Requirements: {
      trust_threat_analysis: r3Item, migration_recovery_rollback: r3Item,
      specialized_gates: r3Item, scoped_authorization: r3Item, production_observation: r3Item,
    },
    assistedReview: {
      checklist: {
        scope_coverage: assistedItem, acceptance_sufficiency: assistedItem,
        authority_completeness: assistedItem, r3_dimensions: assistedItem,
        compatibility_consideration: assistedItem, self_review_alignment: assistedItem,
      },
      selfReviewComparison: {
        dimensions: SELF_REVIEW_DIMENSIONS.map((name) => ({ name, selfStatus: 'PASS', reviewerStatus: 'PASS', observation: 'The assessments agree.' })),
        agreementRate: 100,
        codexMissed: [],
        codexOvercautious: [],
      },
    },
    findings: [], nextStage: 'implementation', userActionRequired: false,
  }
  writeFileSync(result.reviewPath, stringify(review))
  return { ...result, contract, reviewPath: result.reviewPath }
}

function installHistoricalAuthority(input: {
  root: string
  taskId: string
  reviewPath: string
  kind?: string
  listed?: boolean
}): { snapshotPath: string; manifestPath: string } {
  const authorityPath = join(input.root, 'authority.md')
  const historical = readFileSync(authorityPath)
  const ref = {
    id: 'E-002',
    kind: input.kind ?? 'authority',
    path: 'authority.md',
    sha256: sha256(historical),
    digest: canonicalDigest(historical.toString('utf8')),
  }
  writeFileSync(authorityPath, 'upgraded authority\n')
  const snapshotRelative = '.delivery/compatibility/evidence/authority.md'
  const snapshotPath = join(input.root, snapshotRelative)
  mkdirSync(join(snapshotPath, '..'), { recursive: true })
  writeFileSync(snapshotPath, historical)
  const entry = {
    path: input.listed === false ? 'other.md' : ref.path,
    sha256: ref.sha256,
    digest: ref.digest,
    snapshotPath: snapshotRelative,
    snapshotSha256: ref.sha256,
  }
  const unsigned = {
    schemaVersion: 1,
    artifactType: 'engineering-governance-historical-evidence-compatibility-v1',
    projectId: 'fixture-project',
    entries: [entry],
  }
  const manifest = { ...unsigned, manifestDigest: canonicalDigest(unsigned) }
  const manifestRelative = '.delivery/compatibility/historical-evidence.yaml'
  const manifestPath = join(input.root, manifestRelative)
  writeFileSync(manifestPath, stringify(manifest))
  writeFileSync(join(input.root, '.delivery/policy.yaml'), stringify({
    schemaVersion: 1,
    sopVersion: '2.1.0',
    sopDigest: 'a'.repeat(64),
    projectId: 'fixture-project',
    adapters: [],
    artifactMapping: {
      'taskGraph.historicalEvidenceManifestPath': manifestRelative,
      'taskGraph.historicalEvidenceManifestSha256': sha256(readFileSync(manifestPath)),
    },
  }))
  const review = parse(readFileSync(input.reviewPath, 'utf8')) as Record<string, any>
  review.checklist.scope_non_goals.evidenceRefs.push(ref)
  writeFileSync(input.reviewPath, stringify(review))
  return { snapshotPath, manifestPath }
}

function rewriteHistoricalManifest(
  root: string,
  manifestPath: string,
  mutate: (manifest: Record<string, any>) => void,
): void {
  const manifest = parse(readFileSync(manifestPath, 'utf8')) as Record<string, any>
  mutate(manifest)
  delete manifest.manifestDigest
  manifest.manifestDigest = canonicalDigest(manifest)
  writeFileSync(manifestPath, stringify(manifest))
  const policyPath = join(root, '.delivery/policy.yaml')
  const policy = parse(readFileSync(policyPath, 'utf8')) as Record<string, any>
  policy.artifactMapping['taskGraph.historicalEvidenceManifestSha256'] = sha256(readFileSync(manifestPath))
  writeFileSync(policyPath, stringify(policy))
}

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('contract readiness gate', () => {
  it.each([
    ['null', 'null'],
    ['array', '[]'],
    ['schema-only', 'schemaVersion: 2\n'],
    ['missing-nested', 'schemaVersion: 2\nartifactType: sop-contract-review-v2\n'],
  ])('rejects malformed canonical review (%s) without throwing', (_name, content) => {
    const { root, taskId, reviewPath } = fixture()
    writeFileSync(reviewPath, content)
    expect(() => verifyContractReadinessArtifact(root, taskId, reviewPath)).not.toThrow()
    const result = verifyContractReadinessArtifact(root, taskId, reviewPath)
    expect(result.valid).toBe(false)
    expect(result.errors.some((error) => error.includes('SCHEMA_INVALID'))).toBe(true)
  })

  it('accepts an exact independent review and binds it to IN_PROGRESS', () => {
    const { root, taskId, reviewPath } = fixture()
    const verification = verifyContractReadinessArtifact(root, taskId, reviewPath)
    expect(verification.valid).toBe(true)
    const plan = planTaskTransition({
      projectRoot: root,
      taskId,
      actorId: 'codex',
      to: 'IN_PROGRESS',
      artifacts: [{ kind: 'contract-review', path: reviewPath }],
    })
    expect(plan.event.artifactRefs).toHaveLength(1)
    expect(plan.event.artifactRefs[0]?.kind).toBe('contract-review')
  })

  it('accepts exact policy-bound historical authority bytes after an upgrade', () => {
    const { root, taskId, reviewPath } = fixture()
    installHistoricalAuthority({ root, taskId, reviewPath })
    expect(verifyContractReadinessArtifact(root, taskId, reviewPath).valid).toBe(true)
  })

  it('rejects wrong-kind, unlisted, tampered, and partially configured historical authority evidence', () => {
    const wrongKind = fixture()
    installHistoricalAuthority({ ...wrongKind, kind: 'record' })
    expect(verifyContractReadinessArtifact(wrongKind.root, wrongKind.taskId, wrongKind.reviewPath).valid).toBe(false)

    const unlisted = fixture()
    installHistoricalAuthority({ ...unlisted, listed: false })
    expect(verifyContractReadinessArtifact(unlisted.root, unlisted.taskId, unlisted.reviewPath).valid).toBe(false)

    const tampered = fixture()
    const installed = installHistoricalAuthority(tampered)
    writeFileSync(installed.snapshotPath, 'tampered\n')
    expect(verifyContractReadinessArtifact(tampered.root, tampered.taskId, tampered.reviewPath).errors)
      .toContain('HISTORICAL_EVIDENCE_SNAPSHOT_INVALID:authority.md')

    const partial = fixture()
    installHistoricalAuthority(partial)
    const policyPath = join(partial.root, '.delivery/policy.yaml')
    const policy = parse(readFileSync(policyPath, 'utf8')) as Record<string, any>
    delete policy.artifactMapping['taskGraph.historicalEvidenceManifestSha256']
    writeFileSync(policyPath, stringify(policy))
    expect(verifyContractReadinessArtifact(partial.root, partial.taskId, partial.reviewPath).errors)
      .toContain('HISTORICAL_EVIDENCE_MAPPING_INVALID')
  })

  it('rejects omitted snapshots, isolated SHA/digest substitution, and manifest drift', () => {
    const omitted = fixture()
    const omittedInstall = installHistoricalAuthority(omitted)
    rmSync(omittedInstall.snapshotPath)
    expect(verifyContractReadinessArtifact(omitted.root, omitted.taskId, omitted.reviewPath).errors)
      .toContain('HISTORICAL_EVIDENCE_SNAPSHOT_INVALID:authority.md')

    const shaChanged = fixture()
    const shaInstall = installHistoricalAuthority(shaChanged)
    rewriteHistoricalManifest(shaChanged.root, shaInstall.manifestPath, (manifest) => {
      manifest.entries[0].sha256 = '0'.repeat(64)
      manifest.entries[0].snapshotSha256 = '0'.repeat(64)
    })
    expect(verifyContractReadinessArtifact(shaChanged.root, shaChanged.taskId, shaChanged.reviewPath).errors)
      .toContain('HISTORICAL_EVIDENCE_SNAPSHOT_INVALID:authority.md')

    const digestChanged = fixture()
    const digestInstall = installHistoricalAuthority(digestChanged)
    rewriteHistoricalManifest(digestChanged.root, digestInstall.manifestPath, (manifest) => {
      manifest.entries[0].digest = '0'.repeat(64)
    })
    expect(verifyContractReadinessArtifact(digestChanged.root, digestChanged.taskId, digestChanged.reviewPath).errors)
      .toContain('HISTORICAL_EVIDENCE_SNAPSHOT_INVALID:authority.md')

    const drifted = fixture()
    const driftedInstall = installHistoricalAuthority(drifted)
    writeFileSync(
      driftedInstall.manifestPath,
      `${readFileSync(driftedInstall.manifestPath, 'utf8')}\n`,
    )
    expect(verifyContractReadinessArtifact(drifted.root, drifted.taskId, drifted.reviewPath).errors)
      .toContain('HISTORICAL_EVIDENCE_MANIFEST_SHA_MISMATCH')
  })

  it('accepts a non-empty valid ledger prefix after an append-only transition', () => {
    const { root, taskId, reviewPath } = fixture()
    const ledgerPath = join(root, `.delivery/tasks/${taskId}/ledger.jsonl`)
    const ledgerRaw = readFileSync(ledgerPath)
    const review = parse(readFileSync(reviewPath, 'utf8')) as Record<string, any>
    const ledgerRef = {
      id: 'E-002',
      kind: 'record',
      path: `.delivery/tasks/${taskId}/ledger.jsonl`,
      sha256: sha256(ledgerRaw),
      digest: canonicalDigest(ledgerRaw.toString('utf8')),
    }
    review.checklist.scope_non_goals.evidenceRefs.push(ledgerRef)
    review.r3Requirements.trust_threat_analysis.evidenceRefs.push(ledgerRef)
    writeFileSync(reviewPath, stringify(review))
    const plan = planTaskTransition({
      projectRoot: root,
      taskId,
      actorId: 'codex',
      to: 'IN_PROGRESS',
      artifacts: [{ kind: 'contract-review', path: reviewPath }],
    })
    expect(applyTaskTransition(plan, plan.digest)).toEqual({ applied: true, errors: [] })
    expect(verifyContractReadinessArtifact(root, taskId, reviewPath).valid).toBe(true)
  })

  it('rejects empty prefixes and corrupt JSONL suffixes', () => {
    const { root, taskId, reviewPath } = fixture()
    const review = parse(readFileSync(reviewPath, 'utf8')) as Record<string, any>
    const item = review.checklist.scope_non_goals
    item.evidenceRefs.push({
      id: 'E-002',
      kind: 'record',
      path: `.delivery/tasks/${taskId}/ledger.jsonl`,
      sha256: sha256(''),
      digest: canonicalDigest(''),
    })
    writeFileSync(reviewPath, stringify(review))
    expect(verifyContractReadinessArtifact(root, taskId, reviewPath).errors)
      .toContain('CHECKLIST_scope_non_goals_EVIDENCE_IDENTITY_MISMATCH:E-002')

    item.evidenceRefs[1] = {
      id: 'E-002',
      kind: 'record',
      path: `.delivery/tasks/${taskId}/ledger.jsonl`,
      sha256: sha256(readFileSync(join(root, `.delivery/tasks/${taskId}/ledger.jsonl`))),
      digest: canonicalDigest(readFileSync(join(root, `.delivery/tasks/${taskId}/ledger.jsonl`), 'utf8')),
    }
    writeFileSync(reviewPath, stringify(review))
    const plan = planTaskTransition({
      projectRoot: root,
      taskId,
      actorId: 'codex',
      to: 'IN_PROGRESS',
      artifacts: [{ kind: 'contract-review', path: reviewPath }],
    })
    expect(applyTaskTransition(plan, plan.digest).applied).toBe(true)
    writeFileSync(
      join(root, `.delivery/tasks/${taskId}/ledger.jsonl`),
      `${readFileSync(join(root, `.delivery/tasks/${taskId}/ledger.jsonl`), 'utf8')}not-json\n`,
    )
    expect(verifyContractReadinessArtifact(root, taskId, reviewPath).errors)
      .toContain('CHECKLIST_scope_non_goals_EVIDENCE_IDENTITY_MISMATCH:E-002')
  })

  it('rejects a cross-task ledger prefix reference', () => {
    const { root, taskId, reviewPath } = fixture()
    const source = join(root, `.delivery/tasks/${taskId}/ledger.jsonl`)
    const other = join(root, '.delivery/tasks/other-task/ledger.jsonl')
    mkdirSync(join(other, '..'), { recursive: true })
    writeFileSync(other, readFileSync(source))
    const review = parse(readFileSync(reviewPath, 'utf8')) as Record<string, any>
    review.checklist.scope_non_goals.evidenceRefs.push({
      id: 'E-002',
      kind: 'record',
      path: '.delivery/tasks/other-task/ledger.jsonl',
      sha256: sha256(readFileSync(other)),
      digest: canonicalDigest(readFileSync(other, 'utf8')),
    })
    writeFileSync(reviewPath, stringify(review))
    writeFileSync(other, `${readFileSync(other, 'utf8')}${readFileSync(other, 'utf8')}`)
    expect(verifyContractReadinessArtifact(root, taskId, reviewPath).errors)
      .toContain('CHECKLIST_scope_non_goals_EVIDENCE_IDENTITY_MISMATCH:E-002')
  })

  it('rejects a JSON-valid suffix with a forged event digest', () => {
    const { root, taskId, reviewPath } = fixture()
    const ledgerPath = join(root, `.delivery/tasks/${taskId}/ledger.jsonl`)
    const ledgerRaw = readFileSync(ledgerPath)
    const review = parse(readFileSync(reviewPath, 'utf8')) as Record<string, any>
    review.checklist.scope_non_goals.evidenceRefs.push({
      id: 'E-002',
      kind: 'record',
      path: `.delivery/tasks/${taskId}/ledger.jsonl`,
      sha256: sha256(ledgerRaw),
      digest: canonicalDigest(ledgerRaw.toString('utf8')),
    })
    writeFileSync(reviewPath, stringify(review))
    const plan = planTaskTransition({
      projectRoot: root,
      taskId,
      actorId: 'codex',
      to: 'IN_PROGRESS',
      artifacts: [{ kind: 'contract-review', path: reviewPath }],
    })
    expect(applyTaskTransition(plan, plan.digest).applied).toBe(true)
    const events = readFileSync(ledgerPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    events[1].eventDigest = '0'.repeat(64)
    writeFileSync(ledgerPath, `${events.map((event) => JSON.stringify(event)).join('\n')}\n`)
    expect(verifyContractReadinessArtifact(root, taskId, reviewPath).errors)
      .toContain('CHECKLIST_scope_non_goals_EVIDENCE_IDENTITY_MISMATCH:E-002')
  })

  it('structurally validates an own-ledger reference even when its identity matches exactly', () => {
    const { root, taskId, reviewPath } = fixture()
    const ledgerPath = join(root, `.delivery/tasks/${taskId}/ledger.jsonl`)
    const event = JSON.parse(readFileSync(ledgerPath, 'utf8')) as Record<string, any>
    event.contractDigest = '0'.repeat(64)
    delete event.eventDigest
    event.eventDigest = canonicalDigest(event)
    writeFileSync(ledgerPath, `${JSON.stringify(event)}\n`)
    const ledgerRaw = readFileSync(ledgerPath)
    const review = parse(readFileSync(reviewPath, 'utf8')) as Record<string, any>
    review.checklist.scope_non_goals.evidenceRefs.push({
      id: 'E-002',
      kind: 'record',
      path: `.delivery/tasks/${taskId}/ledger.jsonl`,
      sha256: sha256(ledgerRaw),
      digest: canonicalDigest(ledgerRaw.toString('utf8')),
    })
    writeFileSync(reviewPath, stringify(review))
    expect(verifyContractReadinessArtifact(root, taskId, reviewPath).errors)
      .toContain('CHECKLIST_scope_non_goals_EVIDENCE_IDENTITY_MISMATCH:E-002')
  })

  it.each([
    ['wrong kind', (raw: Buffer) => ({ kind: 'contract', sha256: sha256(raw), digest: canonicalDigest(raw.toString('utf8')) })],
    ['wrong SHA', (raw: Buffer) => ({ kind: 'record', sha256: '0'.repeat(64), digest: canonicalDigest(raw.toString('utf8')) })],
    ['wrong digest', (raw: Buffer) => ({ kind: 'record', sha256: sha256(raw), digest: '0'.repeat(64) })],
    ['mid-line prefix', (raw: Buffer) => {
      const partial = raw.subarray(0, Math.max(1, raw.indexOf(0x0a) - 1))
      return { kind: 'record', sha256: sha256(partial), digest: canonicalDigest(partial.toString('utf8')) }
    }],
  ])('rejects an own-ledger %s reference', (_name, identity) => {
    const { root, taskId, reviewPath } = fixture()
    const ledgerRaw = readFileSync(join(root, `.delivery/tasks/${taskId}/ledger.jsonl`))
    const review = parse(readFileSync(reviewPath, 'utf8')) as Record<string, any>
    review.checklist.scope_non_goals.evidenceRefs.push({
      id: 'E-002',
      path: `.delivery/tasks/${taskId}/ledger.jsonl`,
      ...identity(ledgerRaw),
    })
    writeFileSync(reviewPath, stringify(review))
    expect(verifyContractReadinessArtifact(root, taskId, reviewPath).errors)
      .toContain('CHECKLIST_scope_non_goals_EVIDENCE_IDENTITY_MISMATCH:E-002')
  })

  it('rejects append-prefix semantics on a non-ledger path', () => {
    const { root, taskId, reviewPath } = fixture()
    const ledgerRaw = readFileSync(join(root, `.delivery/tasks/${taskId}/ledger.jsonl`))
    const otherPath = join(root, `.delivery/tasks/${taskId}/not-ledger.jsonl`)
    writeFileSync(otherPath, ledgerRaw)
    const review = parse(readFileSync(reviewPath, 'utf8')) as Record<string, any>
    review.checklist.scope_non_goals.evidenceRefs.push({
      id: 'E-002',
      kind: 'record',
      path: `.delivery/tasks/${taskId}/not-ledger.jsonl`,
      sha256: sha256(ledgerRaw),
      digest: canonicalDigest(ledgerRaw.toString('utf8')),
    })
    writeFileSync(reviewPath, stringify(review))
    writeFileSync(otherPath, Buffer.concat([ledgerRaw, ledgerRaw]))
    expect(verifyContractReadinessArtifact(root, taskId, reviewPath).errors)
      .toContain('CHECKLIST_scope_non_goals_EVIDENCE_IDENTITY_MISMATCH:E-002')
  })

  it.each(['truncated', 'replaced', 'reordered'] as const)('rejects a %s current ledger', (attack) => {
    const { root, taskId, reviewPath } = fixture()
    const ledgerPath = join(root, `.delivery/tasks/${taskId}/ledger.jsonl`)
    const prefix = readFileSync(ledgerPath)
    const review = parse(readFileSync(reviewPath, 'utf8')) as Record<string, any>
    review.checklist.scope_non_goals.evidenceRefs.push({
      id: 'E-002',
      kind: 'record',
      path: `.delivery/tasks/${taskId}/ledger.jsonl`,
      sha256: sha256(prefix),
      digest: canonicalDigest(prefix.toString('utf8')),
    })
    writeFileSync(reviewPath, stringify(review))
    const plan = planTaskTransition({
      projectRoot: root,
      taskId,
      actorId: 'codex',
      to: 'IN_PROGRESS',
      artifacts: [{ kind: 'contract-review', path: reviewPath }],
    })
    expect(applyTaskTransition(plan, plan.digest).applied).toBe(true)
    const lines = readFileSync(ledgerPath, 'utf8').trim().split('\n')
    if (attack === 'truncated') writeFileSync(ledgerPath, `${lines[1]}\n`)
    if (attack === 'replaced') writeFileSync(ledgerPath, `${lines[0]!.replace(taskId, 'other-task')}\n`)
    if (attack === 'reordered') writeFileSync(ledgerPath, `${lines.reverse().join('\n')}\n`)
    expect(verifyContractReadinessArtifact(root, taskId, reviewPath).errors)
      .toContain('CHECKLIST_scope_non_goals_EVIDENCE_IDENTITY_MISMATCH:E-002')
  })

  it('rejects end truncation back to an accepted review ledger prefix in the task graph', () => {
    const { root, taskId, reviewPath } = fixture()
    const ledgerPath = join(root, `.delivery/tasks/${taskId}/ledger.jsonl`)
    const prefix = readFileSync(ledgerPath)
    const review = parse(readFileSync(reviewPath, 'utf8')) as Record<string, any>
    review.checklist.scope_non_goals.evidenceRefs.push({
      id: 'E-002',
      kind: 'record',
      path: `.delivery/tasks/${taskId}/ledger.jsonl`,
      sha256: sha256(prefix),
      digest: canonicalDigest(prefix.toString('utf8')),
    })
    writeFileSync(reviewPath, stringify(review))
    const plan = planTaskTransition({
      projectRoot: root,
      taskId,
      actorId: 'codex',
      to: 'IN_PROGRESS',
      artifacts: [{ kind: 'contract-review', path: reviewPath }],
    })
    expect(applyTaskTransition(plan, plan.digest).applied).toBe(true)
    writeFileSync(ledgerPath, prefix)
    expect(validateProjectTaskGraph(root).errors).toContain(
      `TASK_GRAPH_CONTRACT_REVIEW_LEDGER_PREFIX_NOT_ADVANCED:${taskId}`,
    )
  })

  it('renders an accepted review as a short confirmation summary', () => {
    const { root, taskId } = fixture()
    const summary = generateReviewSummary(root, taskId)
    expect(summary.decision).toBe('ACCEPTED')
    expect(summary.confirmationRequired).toBe(true)
    expect(summary.nextAction).toContain('DEFINED to IN_PROGRESS')
  })

  it('requires exact independent assisted-review comparison for mutual-review contracts', () => {
    const { root, taskId, reviewPath } = mutualReviewFixture()
    expect(verifyContractReadinessArtifact(root, taskId, reviewPath).errors).toEqual([
      'ACCOUNTABILITY_ACTOR_UNAVAILABLE',
    ])
    expect(buildContractReviewRequest(root, taskId).reviewerConstraints.independentFrom).toEqual([
      'codex', 'contract-author',
    ])
    const review = parse(readFileSync(reviewPath, 'utf8')) as Record<string, any>
    review.assistedReview.selfReviewComparison.agreementRate = 50
    writeFileSync(reviewPath, stringify(review))
    expect(verifyContractReadinessArtifact(root, taskId, reviewPath).errors)
      .toContain('CONTRACT_REVIEW_COMPARISON_RATE_INVALID')

    review.assistedReview.selfReviewComparison.agreementRate = 100
    review.reviewer.id = 'contract-author'
    writeFileSync(reviewPath, stringify(review))
    expect(verifyContractReadinessArtifact(root, taskId, reviewPath).errors)
      .toContain('CONTRACT_REVIEW_SELF_REVIEW_FORBIDDEN')
  })

  it('rejects self-review and stale contract bytes', () => {
    const { root, taskId, reviewPath } = fixture()
    const review = parse(readFileSync(reviewPath, 'utf8')) as Record<string, any>
    review.reviewer.id = 'CODEX'
    writeFileSync(reviewPath, stringify(review))
    expect(verifyContractReadinessArtifact(root, taskId, reviewPath).errors).toContain('CONTRACT_REVIEW_SELF_REVIEW_FORBIDDEN')
    review.reviewer.id = 'independent-reviewer'
    writeFileSync(reviewPath, stringify(review))
    writeFileSync(join(root, `.delivery/tasks/${taskId}/contract.yaml`), `${readFileSync(join(root, `.delivery/tasks/${taskId}/contract.yaml`), 'utf8')}\n`)
    expect(() => planTaskTransition({
      projectRoot: root, taskId, actorId: 'codex', to: 'IN_PROGRESS', artifacts: [{ kind: 'contract-review', path: reviewPath }],
    })).toThrow('TASK_LEDGER_INVALID')
  })

  it('requires findings to be ordered by severity and then ID', () => {
    const { root, taskId, reviewPath } = fixture()
    const review = parse(readFileSync(reviewPath, 'utf8')) as Record<string, any>
    const evidenceRefs = review.checklist.scope_non_goals.evidenceRefs
    review.decision = 'REPAIR_REQUIRED'
    review.nextStage = 'contract-repair'
    review.userActionRequired = true
    review.findings = [
      { id: 'CR-002', severity: 'BLOCKER', classification: 'contract_violation', observation: 'blocker', requiredChange: 'fix', evidenceRefs },
      { id: 'CR-001', severity: 'HIGH', classification: 'contract_violation', observation: 'high', requiredChange: 'fix', evidenceRefs },
    ]
    writeFileSync(reviewPath, stringify(review))
    expect(verifyContractReadinessArtifact(root, taskId, reviewPath).valid).toBe(true)
    review.findings = [
      { id: 'CR-002', severity: 'HIGH', classification: 'contract_violation', observation: 'high 2', requiredChange: 'fix', evidenceRefs },
      { id: 'CR-001', severity: 'HIGH', classification: 'contract_violation', observation: 'high 1', requiredChange: 'fix', evidenceRefs },
    ]
    writeFileSync(reviewPath, stringify(review))
    expect(verifyContractReadinessArtifact(root, taskId, reviewPath).errors)
      .toContain('CONTRACT_REVIEW_FINDINGS_NOT_UNIQUE_SEVERITY_SORTED')
  })
})
