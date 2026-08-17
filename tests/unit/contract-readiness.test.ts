import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import { parse, stringify } from 'yaml'

import { startTask } from '../../src/commands/task-start.js'
import { canonicalDigest } from '../../src/model/digest.js'
import { planTaskTransition } from '../../src/state/ledger.js'
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
  contract.contractReadiness.gateVersion = '2.1.0-re'
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
