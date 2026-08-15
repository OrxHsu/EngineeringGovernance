import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import { parse, stringify } from 'yaml'

import { governanceIdentity } from '../../src/commands/adopt.js'
import { checkProject } from '../../src/commands/check.js'
import { startTask, taskContractDigest } from '../../src/commands/task-start.js'
import { captureCommandExecution } from '../../src/evidence/capture.js'
import { canonicalDigest } from '../../src/model/digest.js'
import { validateProjectTaskGraph } from '../../src/project/task-graph.js'
import {
  applyTaskTransition,
  planTaskTransition,
  readTaskLedger,
} from '../../src/state/ledger.js'

const temporaryDirectories: string[] = []

function sha256(input: string | Uint8Array): string {
  return createHash('sha256').update(input).digest('hex')
}

function writeAcceptedReadinessReview(root: string, taskId: string): void {
  const contractPath = join(root, `.delivery/tasks/${taskId}/contract.yaml`)
  const contractRaw = readFileSync(contractPath)
  const contract = parse(contractRaw.toString('utf8')) as Record<string, unknown>
  const evidenceRef = {
    id: 'E-001',
    kind: 'contract',
    path: `.delivery/tasks/${taskId}/contract.yaml`,
    sha256: sha256(contractRaw),
    digest: canonicalDigest(contract),
  }
  const item = { status: 'PASS', evidenceRefs: [evidenceRef] }
  const na = { status: 'NA', applicabilityReason: 'risk-below-r3', evidenceRefs: [evidenceRef] }
  writeFileSync(join(root, `.delivery/tasks/${taskId}/contract-review.yaml`), stringify({
    schemaVersion: 2,
    artifactType: 'sop-contract-review-v2',
    reviewId: `crv-${taskId}-${String(contract.contractDigest)}`,
    taskId,
    risk: contract.risk,
    reviewer: { id: 'independent-graph-reviewer', trustLevel: 'local-claim' },
    decision: 'ACCEPTED',
    contract: { path: contractPath, rawSha256: sha256(contractRaw), digest: contract.contractDigest },
    checklist: Object.fromEntries([
      'scope_non_goals', 'authority_dependencies', 'risk_owner_reviewer',
      'behavior_state_transitions', 'security_trust', 'evidence_environment',
      'external_source_provenance', 'rollout_recovery_compatibility',
      'unresolved_product_decisions',
    ].map((key) => [key, item])),
    r3Requirements: Object.fromEntries([
      'trust_threat_analysis', 'migration_recovery_rollback', 'specialized_gates',
      'scoped_authorization', 'production_observation',
    ].map((key) => [key, na])),
    findings: [],
    nextStage: 'implementation',
    userActionRequired: false,
  }))
}

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { recursive: true, force: true })
  }
})

function definedTaskFixture(taskId = 'graph-task'): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'sop-task-graph-')))
  temporaryDirectories.push(root)
  execFileSync('git', ['-C', root, 'init', '-b', 'main'])
  execFileSync('git', ['-C', root, 'config', 'user.email', 'test@example.com'])
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Test'])
  writeFileSync(join(root, 'baseline.txt'), 'baseline\n')
  execFileSync('git', ['-C', root, 'add', 'baseline.txt'])
  execFileSync('git', ['-C', root, 'commit', '-m', 'baseline'])

  const result = startTask({
    schemaVersion: 2,
    taskId,
    implementationOwner: 'codex',
    objective: 'Exercise project task graph validation.',
    scope: ['src/**'],
    nonGoals: [],
    authorityInputs: ['spec.md'],
    repositories: [{ id: 'root', path: root }],
    acceptance: [{
      id: 'AC-01',
      observation: 'The command succeeds.',
      positiveCases: ['exit zero'],
      negativeCases: ['non-zero exit'],
      evidenceKind: 'unit',
      command: {
        repositoryId: 'root', cwd: '.', executable: process.execPath, arguments: ['--version'],
      },
      observerPolicy: {
        expectedExitCode: 0,
        output: 'nonempty',
        checkoutMutation: 'forbidden',
        replay: 'not-required',
      },
    }],
    authorizationRequirements: [],
    openChoices: [],
    signals: { mutation: true, crossModule: true },
  })
  for (const artifact of result.artifacts) {
    const path = join(root, artifact.path)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, artifact.content)
  }
  writeAcceptedReadinessReview(root, taskId)
  return root
}

function legacyTaskFixture(taskId = 'legacy-task'): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'sop-task-graph-legacy-')))
  temporaryDirectories.push(root)
  const unsignedContract = {
    schemaVersion: 1,
    taskId,
    sopVersion: '1.0.0',
    risk: 'R2',
    state: 'DEFINED',
    implementationOwner: 'codex',
    objective: 'Preserve historical task evidence.',
    scope: ['src/**'],
    nonGoals: [],
    authorityInputs: ['historical-spec.md'],
    acceptance: [{
      id: 'LEGACY-01',
      observation: 'Historical evidence remains inspectable.',
      positiveCases: ['valid historical record'],
      negativeCases: ['rewritten history'],
    }],
    requiredGates: ['historical gate'],
    openChoices: [],
  }
  const contractPath = join(root, '.delivery', 'tasks', taskId, 'contract.yaml')
  mkdirSync(join(contractPath, '..'), { recursive: true })
  writeFileSync(contractPath, stringify({
    ...unsignedContract,
    contractDigest: taskContractDigest(unsignedContract),
  }))
  return root
}

function candidateTaskFixture(taskId = 'candidate-task'): {
  root: string
  taskId: string
  candidate: Record<string, unknown>
  candidatePath: string
  evidencePath: string
  contract: Record<string, unknown>
  contractPath: string
  receiptPath: string
} {
  const root = definedTaskFixture(taskId)
  const taskRoot = join(root, '.delivery', 'tasks', taskId)
  const contractPath = join(taskRoot, 'contract.yaml')
  const contractRaw = readFileSync(contractPath)
  const contract = parse(contractRaw.toString('utf8')) as Record<string, unknown>
  writeAcceptedReadinessReview(root, taskId)
  const inProgress = planTaskTransition({
    projectRoot: root,
    taskId,
    actorId: 'codex',
    to: 'IN_PROGRESS',
    artifacts: [{ kind: 'contract-review', path: join(taskRoot, 'contract-review.yaml') }],
  })
  expect(applyTaskTransition(inProgress, inProgress.digest)).toEqual({ applied: true, errors: [] })

  const receipt = captureCommandExecution({
    schemaVersion: 2,
    projectRoot: root,
    taskId,
    acceptanceId: 'AC-01',
    runId: 'run-1',
  })
  const receiptPath = join(taskRoot, 'receipts', 'run-1', 'AC-01.json')
  const head = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  const tree = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD^{tree}'], {
    encoding: 'utf8',
  }).trim()
  const implementationIdentities = [{
    repositoryId: 'root',
    repository: root,
    commit: head,
    tree,
    checkoutDigest: canonicalDigest(receipt.repositoriesBefore[0]),
  }]
  const identity = governanceIdentity()
  const evidence = {
    schemaVersion: 2,
    artifactType: 'sop-evidence-v2',
    taskId,
    contractDigest: contract.contractDigest,
    runId: 'run-1',
    runner: { version: identity.version, policyDigest: identity.digest },
    implementationIdentities,
    receipts: [{
      acceptanceId: 'AC-01',
      path: `.delivery/tasks/${taskId}/receipts/run-1/AC-01.json`,
      sha256: sha256(readFileSync(receiptPath)),
    }],
    summary: { passedIds: ['AC-01'], failedIds: [] },
  }
  const evidencePath = join(taskRoot, 'evidence.json')
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`)
  const candidate = {
    schemaVersion: 2,
    taskId,
    contract: { path: contractPath, sha256: sha256(contractRaw) },
    evidence: { path: evidencePath, sha256: sha256(readFileSync(evidencePath)) },
    implementationIdentities,
    gitIdentities: [{
      repositoryId: 'root',
      repository: root,
      implementationCommit: head,
      implementationTree: tree,
      closureCommit: head,
      allowedClosurePaths: ['.delivery/tasks/**'],
    }],
    authorizationArtifacts: [],
    extensionArtifacts: [],
  }
  const candidatePath = join(taskRoot, 'candidate.yaml')
  writeFileSync(candidatePath, stringify(candidate))
  const candidateTransition = planTaskTransition({
    projectRoot: root,
    taskId,
    actorId: 'codex',
    to: 'CANDIDATE',
    artifacts: [
      { kind: 'candidate', path: candidatePath },
      { kind: 'evidence', path: evidencePath },
    ],
  })
  expect(applyTaskTransition(candidateTransition, candidateTransition.digest)).toEqual({
    applied: true,
    errors: [],
  })
  return {
    root,
    taskId,
    candidate,
    candidatePath,
    evidencePath,
    contract,
    contractPath,
    receiptPath,
  }
}

function writeVerification(
  fixture: ReturnType<typeof candidateTaskFixture>,
): { path: string; value: Record<string, unknown> } {
  const candidateRaw = readFileSync(fixture.candidatePath)
  const contractRaw = readFileSync(fixture.contractPath)
  const evidenceRaw = readFileSync(fixture.evidencePath)
  const identity = governanceIdentity()
  const verification = {
    schemaVersion: 2,
    artifactType: 'sop-candidate-verification-v2',
    producer: {
      name: '@xgh/engineering-governance',
      version: identity.version,
      policyDigest: identity.digest,
    },
    taskId: fixture.taskId,
    contract: {
      path: fixture.contractPath,
      sha256: sha256(contractRaw),
      digest: fixture.contract.contractDigest,
    },
    candidate: {
      path: fixture.candidatePath,
      sha256: sha256(candidateRaw),
      digest: canonicalDigest(fixture.candidate),
    },
    evidence: { path: fixture.evidencePath, sha256: sha256(evidenceRaw) },
    receipts: [{
      acceptanceId: 'AC-01',
      path: fixture.receiptPath,
      sha256: sha256(readFileSync(fixture.receiptPath)),
    }],
    authorizationArtifacts: [],
    extensionArtifacts: [],
    implementationIdentities: fixture.candidate.implementationIdentities,
    authorizationTrust: [],
    extensionResults: [],
    verifiedAt: new Date().toISOString(),
    decision: 'eligible',
  }
  const path = join(
    fixture.root,
    '.delivery',
    'tasks',
    fixture.taskId,
    'verification.json',
  )
  writeFileSync(path, `${JSON.stringify(verification, null, 2)}\n`)
  return { path, value: verification }
}

function writeAcceptedReview(
  fixture: ReturnType<typeof candidateTaskFixture>,
  verification: ReturnType<typeof writeVerification>,
): { path: string; value: Record<string, unknown> } {
  const review = {
    schemaVersion: 2,
    artifactType: 'sop-review-v2',
    taskId: fixture.taskId,
    reviewer: { id: 'independent-reviewer', trustLevel: 'local-claim' },
    decision: 'ACCEPTED',
    contract: verification.value.contract,
    candidate: verification.value.candidate,
    verification: { path: verification.path, sha256: sha256(readFileSync(verification.path)) },
    reviewedImplementation: fixture.candidate.implementationIdentities,
    findings: [],
    nextStage: 'close',
    userActionRequired: false,
  }
  const path = join(fixture.root, '.delivery', 'tasks', fixture.taskId, 'review.yaml')
  writeFileSync(path, stringify(review))
  const transition = planTaskTransition({
    projectRoot: fixture.root,
    taskId: fixture.taskId,
    actorId: 'independent-reviewer',
    to: 'ACCEPTED',
    artifacts: [
      { kind: 'review', path },
      { kind: 'verification', path: verification.path },
    ],
  })
  expect(applyTaskTransition(transition, transition.digest)).toEqual({ applied: true, errors: [] })
  return { path, value: review }
}

function writeClosedArtifact(
  fixture: ReturnType<typeof candidateTaskFixture>,
  verification: ReturnType<typeof writeVerification>,
  review: ReturnType<typeof writeAcceptedReview>,
): { path: string; value: Record<string, unknown> } {
  const contractRaw = readFileSync(fixture.contractPath)
  const ledger = readTaskLedger({
    projectRoot: fixture.root,
    taskId: fixture.taskId,
    contractDigest: String(fixture.contract.contractDigest),
    contractSha256: sha256(contractRaw),
    implementationOwner: String(fixture.contract.implementationOwner),
  })
  expect(ledger.valid).toBe(true)
  expect(ledger.currentState).toBe('ACCEPTED')
  const statusPath = join(fixture.root, '.delivery', 'tasks', fixture.taskId, 'status.md')
  const nextAction = 'Archive the completed task.'
  writeFileSync(statusPath, `${fixture.taskId}\n${nextAction}\n`)
  const closure = {
    schemaVersion: 2,
    artifactType: 'sop-closure-v2',
    taskId: fixture.taskId,
    closer: { id: 'codex', trustLevel: 'local-claim' },
    contract: verification.value.contract,
    candidate: verification.value.candidate,
    verification: review.value.verification,
    review: { path: review.path, sha256: sha256(readFileSync(review.path)) },
    acceptedEventDigest: ledger.events.at(-1)!.eventDigest,
    statusArtifacts: [{ path: statusPath, sha256: sha256(readFileSync(statusPath)) }],
    nextAction,
    userActionRequired: false,
  }
  const path = join(fixture.root, '.delivery', 'tasks', fixture.taskId, 'closure.yaml')
  writeFileSync(path, stringify(closure))
  const transition = planTaskTransition({
    projectRoot: fixture.root,
    taskId: fixture.taskId,
    actorId: 'codex',
    to: 'CLOSED',
    artifacts: [
      { kind: 'closure', path },
      { kind: 'status', path: statusPath },
    ],
  })
  expect(applyTaskTransition(transition, transition.digest)).toEqual({ applied: true, errors: [] })
  return { path, value: closure }
}

describe('v2 project task graph', () => {
  it('accepts one coherent canonical contract and ledger', () => {
    const root = definedTaskFixture()

    expect(validateProjectTaskGraph(root)).toEqual({
      valid: true,
      errors: [],
      tasks: [{
        taskId: 'graph-task',
        schemaVersion: 2,
        mode: 'canonical',
        state: 'DEFINED',
      }],
    })
  })

  it('rejects a digest-coherent contract whose risk semantics are false', () => {
    const root = definedTaskFixture('semantic-drift')
    const taskRoot = join(root, '.delivery/tasks/semantic-drift')
    const contractPath = join(taskRoot, 'contract.yaml')
    const contract = parse(readFileSync(contractPath, 'utf8')) as Record<string, unknown>
    contract.risk = 'R1'
    contract.riskSignals = { security: true }
    const { contractDigest: _oldDigest, ...unsigned } = contract
    contract.contractDigest = canonicalDigest(unsigned)
    writeFileSync(contractPath, stringify(contract))

    const ledgerPath = join(taskRoot, 'ledger.jsonl')
    const event = JSON.parse(readFileSync(ledgerPath, 'utf8')) as Record<string, unknown>
    event.contractDigest = contract.contractDigest
    const references = event.artifactRefs as Array<Record<string, unknown>>
    references[0]!.sha256 = sha256(readFileSync(contractPath))
    const { eventDigest: _oldEventDigest, ...unsignedEvent } = event
    event.eventDigest = canonicalDigest(unsignedEvent)
    writeFileSync(ledgerPath, `${JSON.stringify(event)}\n`)

    expect(validateProjectTaskGraph(root).errors).toContain(
      'TASK_GRAPH_CONTRACT_SEMANTIC_INVALID:semantic-drift:TASK_CONTRACT_RISK_MISMATCH:R1:R3',
    )
  })

  it('reports v1 task directories as legacy inspect-only without rejecting history', () => {
    const root = legacyTaskFixture()

    expect(validateProjectTaskGraph(root)).toEqual({
      valid: true,
      errors: [],
      tasks: [{
        taskId: 'legacy-task',
        schemaVersion: 1,
        mode: 'legacy-inspect-only',
        state: 'INSPECT_ONLY',
      }],
    })
  })

  it('rejects duplicate and cross-task candidate artifacts independent of filename', () => {
    const fixture = candidateTaskFixture('graph-attack')
    const copyPath = join(
      fixture.root,
      '.delivery',
      'tasks',
      fixture.taskId,
      'copies',
      'forged.yaml',
    )
    mkdirSync(join(copyPath, '..'), { recursive: true })
    writeFileSync(copyPath, stringify({ ...fixture.candidate, taskId: 'other-task' }))

    const result = validateProjectTaskGraph(fixture.root)
    expect(result.valid).toBe(false)
    expect(result.errors).toContain('TASK_GRAPH_DUPLICATE_CANDIDATE:graph-attack')
    expect(result.errors).toContain(
      'TASK_GRAPH_CROSS_TASK_ARTIFACT:graph-attack:copies/forged.yaml:other-task',
    )
  })

  it('rejects a current candidate whose bytes no longer match the ledger reference', () => {
    const fixture = candidateTaskFixture('candidate-drift')
    writeFileSync(
      fixture.candidatePath,
      `${readFileSync(fixture.candidatePath, 'utf8')}# post-transition drift\n`,
    )

    expect(validateProjectTaskGraph(fixture.root).errors).toContain(
      'TASK_GRAPH_CURRENT_CANDIDATE_REF_MISMATCH:candidate-drift',
    )
  })

  it('rejects duplicate and cross-task verification artifacts independent of filename', () => {
    const fixture = candidateTaskFixture('verification-attack')
    const verification = writeVerification(fixture)
    const copyPath = join(
      fixture.root,
      '.delivery',
      'tasks',
      fixture.taskId,
      'archive',
      'accepted.json',
    )
    mkdirSync(join(copyPath, '..'), { recursive: true })
    writeFileSync(copyPath, JSON.stringify({ ...verification.value, taskId: 'other-task' }))

    const result = validateProjectTaskGraph(fixture.root)
    expect(result.errors).toContain('TASK_GRAPH_DUPLICATE_VERIFICATION:verification-attack')
    expect(result.errors).toContain(
      'TASK_GRAPH_CROSS_TASK_ARTIFACT:verification-attack:archive/accepted.json:other-task',
    )
  })

  it('rejects a schema-valid verification that differs from recomputed eligibility', () => {
    const fixture = candidateTaskFixture('forged-verification')
    const verification = writeVerification(fixture)
    const producer = verification.value.producer as Record<string, unknown>
    producer.version = 'forged-version'
    writeFileSync(verification.path, `${JSON.stringify(verification.value, null, 2)}\n`)

    expect(validateProjectTaskGraph(fixture.root).errors).toContain(
      'TASK_GRAPH_VERIFICATION_RECOMPUTATION_MISMATCH:forged-verification',
    )
  })

  it('rejects more than one accepted review even when the duplicate has an unrelated filename', () => {
    const fixture = candidateTaskFixture('duplicate-review')
    const verification = writeVerification(fixture)
    const review = writeAcceptedReview(fixture, verification)
    const copyPath = join(
      fixture.root,
      '.delivery',
      'tasks',
      fixture.taskId,
      'archive',
      'approval.yaml',
    )
    mkdirSync(join(copyPath, '..'), { recursive: true })
    writeFileSync(copyPath, stringify(review.value))

    expect(validateProjectTaskGraph(fixture.root).errors).toContain(
      'TASK_GRAPH_DUPLICATE_ACCEPTED_REVIEW:duplicate-review',
    )
  })

  it('rejects an accepted review whose bytes no longer match the ledger reference', () => {
    const fixture = candidateTaskFixture('review-drift')
    const verification = writeVerification(fixture)
    const review = writeAcceptedReview(fixture, verification)
    writeFileSync(review.path, `${readFileSync(review.path, 'utf8')}# post-acceptance drift\n`)

    expect(validateProjectTaskGraph(fixture.root).errors).toContain(
      'TASK_GRAPH_CURRENT_REVIEW_REF_MISMATCH:review-drift',
    )
  })

  it('rejects a verification artifact whose candidate ancestor is missing', () => {
    const fixture = candidateTaskFixture('orphan-verification')
    writeVerification(fixture)
    unlinkSync(fixture.candidatePath)

    expect(validateProjectTaskGraph(fixture.root).errors).toContain(
      'TASK_GRAPH_ORPHAN_VERIFICATION:orphan-verification',
    )
  })

  it('rejects a review artifact that has no ledger review event', () => {
    const fixture = candidateTaskFixture('orphan-review')
    const verification = writeVerification(fixture)
    const reviewPath = join(
      fixture.root,
      '.delivery',
      'tasks',
      fixture.taskId,
      'review.yaml',
    )
    writeFileSync(reviewPath, stringify({
      schemaVersion: 2,
      artifactType: 'sop-review-v2',
      taskId: fixture.taskId,
      reviewer: { id: 'independent-reviewer', trustLevel: 'local-claim' },
      decision: 'ACCEPTED',
      contract: verification.value.contract,
      candidate: verification.value.candidate,
      verification: { path: verification.path, sha256: sha256(readFileSync(verification.path)) },
      reviewedImplementation: fixture.candidate.implementationIdentities,
      findings: [],
      nextStage: 'close',
      userActionRequired: false,
    }))

    expect(validateProjectTaskGraph(fixture.root).errors).toContain(
      'TASK_GRAPH_ORPHAN_REVIEW:orphan-review',
    )
  })

  it('rejects a closed artifact whose bytes no longer match the ledger reference', () => {
    const fixture = candidateTaskFixture('closure-drift')
    const verification = writeVerification(fixture)
    const review = writeAcceptedReview(fixture, verification)
    const closure = writeClosedArtifact(fixture, verification, review)
    writeFileSync(closure.path, `${readFileSync(closure.path, 'utf8')}# post-closure drift\n`)

    expect(validateProjectTaskGraph(fixture.root).errors).toContain(
      'TASK_GRAPH_CURRENT_CLOSURE_REF_MISMATCH:closure-drift',
    )
  })

  it('rejects a closure without an accepted review ancestor', () => {
    const fixture = candidateTaskFixture('orphan-closure')
    const verification = writeVerification(fixture)
    const statusPath = join(fixture.root, '.delivery', 'tasks', fixture.taskId, 'status.md')
    writeFileSync(statusPath, 'orphan-closure\nNo accepted review.\n')
    const closurePath = join(fixture.root, '.delivery', 'tasks', fixture.taskId, 'closure.yaml')
    writeFileSync(closurePath, stringify({
      schemaVersion: 2,
      artifactType: 'sop-closure-v2',
      taskId: fixture.taskId,
      closer: { id: 'codex', trustLevel: 'local-claim' },
      contract: verification.value.contract,
      candidate: verification.value.candidate,
      verification: { path: verification.path, sha256: sha256(readFileSync(verification.path)) },
      review: { path: join(fixture.root, 'missing-review.yaml'), sha256: '0'.repeat(64) },
      acceptedEventDigest: '0'.repeat(64),
      statusArtifacts: [{ path: statusPath, sha256: sha256(readFileSync(statusPath)) }],
      nextAction: 'No accepted review.',
      userActionRequired: false,
    }))

    expect(validateProjectTaskGraph(fixture.root).errors).toContain(
      'TASK_GRAPH_ORPHAN_CLOSURE:orphan-closure',
    )
  })

  it('rejects duplicate closure artifacts independent of filename', () => {
    const fixture = candidateTaskFixture('duplicate-closure')
    const verification = writeVerification(fixture)
    const review = writeAcceptedReview(fixture, verification)
    const closure = writeClosedArtifact(fixture, verification, review)
    const copyPath = join(
      fixture.root,
      '.delivery',
      'tasks',
      fixture.taskId,
      'archive',
      'final.yaml',
    )
    mkdirSync(join(copyPath, '..'), { recursive: true })
    writeFileSync(copyPath, stringify(closure.value))

    expect(validateProjectTaskGraph(fixture.root).errors).toContain(
      'TASK_GRAPH_DUPLICATE_CLOSURE:duplicate-closure',
    )
  })

  it('keeps this repository historical task directories checkable as inspect-only', () => {
    const result = validateProjectTaskGraph(process.cwd())
    expect(result.valid).toBe(true)
    expect(result.tasks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        taskId: 'global-workflow-repair',
        schemaVersion: 1,
        mode: 'legacy-inspect-only',
        state: 'INSPECT_ONLY',
      }),
    ]))
  })

  it('rejects a v2 contract bound to a different project policy identity', () => {
    const root = definedTaskFixture('policy-mismatch')
    writeFileSync(join(root, '.delivery', 'policy.yaml'), stringify({
      sopVersion: '9.9.9',
      sopDigest: '0'.repeat(64),
    }))

    expect(validateProjectTaskGraph(root).errors).toContain(
      'TASK_GRAPH_CONTRACT_POLICY_IDENTITY_MISMATCH:policy-mismatch',
    )
  })

  it('surfaces legacy inspect-only task reports through project check', () => {
    const root = legacyTaskFixture('reported-legacy')
    const result = checkProject(root)

    expect(result.valid).toBe(false)
    expect(result.errors).toContain('PROJECT_POLICY_MISSING')
    expect(result.taskGraph?.tasks).toEqual([{
      taskId: 'reported-legacy',
      schemaVersion: 1,
      mode: 'legacy-inspect-only',
      state: 'INSPECT_ONLY',
    }])
  })
})
