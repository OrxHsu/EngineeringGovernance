import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { parse, stringify } from 'yaml'

import { governanceIdentity } from '../../src/commands/adopt.js'
import { startTask } from '../../src/commands/task-start.js'
import {
  persistHardenedVerificationArtifact,
  type HardenedVerificationArtifact,
} from '../../src/commands/task-verify-v2.js'
import { verifyCandidateEligibility } from '../../src/commands/task-verify.js'
import { captureCommandExecution } from '../../src/evidence/capture.js'
import { canonicalDigest } from '../../src/model/digest.js'
import type { RiskSignals } from '../../src/policy/risk.js'
import { applyTaskTransition, planTaskTransition } from '../../src/state/ledger.js'
import type { ExtensionDescriptor } from '../../src/extensions/registry.js'

export function sha256(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex')
}

function git(repository: string, ...arguments_: string[]): string {
  return execFileSync('git', ['-C', repository, ...arguments_], { encoding: 'utf8' }).trim()
}

function write(path: string, content: string): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content)
}

export function writeAcceptedContractReadinessReview(input: {
  root: string
  taskId: string
  contractPath: string
  contractRaw: Buffer | string
  contract: Record<string, unknown>
  authorizationRequirements?: Array<unknown>
}): string {
  const contractRaw = Buffer.isBuffer(input.contractRaw)
    ? input.contractRaw
    : Buffer.from(input.contractRaw)
  const evidenceRef = {
    id: 'E-001',
    kind: 'contract',
    path: `.delivery/tasks/${input.taskId}/contract.yaml`,
    sha256: sha256(contractRaw),
    digest: canonicalDigest(input.contract),
  }
  const checklistItem = { status: 'PASS', evidenceRefs: [evidenceRef] }
  const r3 = (input.contract.risk === 'R3')
    ? {
      trust_threat_analysis: checklistItem,
      migration_recovery_rollback: checklistItem,
      specialized_gates: checklistItem,
      scoped_authorization: (input.authorizationRequirements ?? []).length > 0
        ? checklistItem
        : { status: 'NA', applicabilityReason: 'no-scoped-authorization-action', evidenceRefs: [evidenceRef] },
      production_observation: { status: 'NA', applicabilityReason: 'no-production-action', evidenceRefs: [evidenceRef] },
    }
    : Object.fromEntries([
      'trust_threat_analysis', 'migration_recovery_rollback', 'specialized_gates',
      'scoped_authorization', 'production_observation',
    ].map((key) => [key, { status: 'NA', applicabilityReason: 'risk-below-r3', evidenceRefs: [evidenceRef] }]))
  const review = {
    schemaVersion: 2,
    artifactType: 'sop-contract-review-v2',
    reviewId: `crv-${input.taskId}-${String(input.contract.contractDigest)}`,
    taskId: input.taskId,
    risk: input.contract.risk,
    reviewer: { id: 'independent-test-reviewer', trustLevel: 'local-claim' },
    decision: 'ACCEPTED',
    contract: { path: input.contractPath, rawSha256: sha256(contractRaw), digest: input.contract.contractDigest },
    checklist: Object.fromEntries([
      'scope_non_goals', 'authority_dependencies', 'risk_owner_reviewer',
      'behavior_state_transitions', 'security_trust', 'evidence_environment',
      'external_source_provenance', 'rollout_recovery_compatibility',
      'unresolved_product_decisions',
    ].map((key) => [key, checklistItem])),
    r3Requirements: r3,
    findings: [],
    nextStage: 'implementation',
    userActionRequired: false,
  }
  const reviewPath = join(input.root, `.delivery/tasks/${input.taskId}/contract-review.yaml`)
  write(reviewPath, stringify(review))
  return reviewPath
}

export interface HardenedTaskFixture {
  root: string
  taskId: string
  contract: Record<string, unknown>
  contractPath: string
  candidate: Record<string, unknown>
  candidatePath: string
  evidencePath: string
  receiptPath: string
  verification: HardenedVerificationArtifact
  verificationPath: string
}

export function hardenedTaskFixture(options: {
  taskId?: string
  implementationOwner?: string
  signals?: RiskSignals
  commandScript?: (root: string) => string
  authorizationRequirements?: Array<{
    id: string
    action: string
    target: string
    scope: string[]
    trustLevel: 'recorded-claim' | 'verified-attestation'
    consumeOnce: boolean
  }>
  authorizationDocuments?: (input: {
    root: string
    taskId: string
    contractDigest: string
  }) => Array<{ requirementId: string; document: Record<string, unknown> }>
  projectExtensions?: ExtensionDescriptor[]
  extensionInputs?: Record<string, unknown>
  extensionDocuments?: (input: {
    root: string
    taskId: string
    contractDigest: string
  }) => Array<{ extensionId: string; kind: string; document: Record<string, unknown> }>
} = {}): HardenedTaskFixture {
  const created = mkdtempSync(join(tmpdir(), 'sop-v2-flow-'))
  const root = realpathSync(created)
  const taskId = options.taskId ?? 'review-flow'
  git(root, 'init', '-b', 'main')
  git(root, 'config', 'user.email', 'test@example.com')
  git(root, 'config', 'user.name', 'Test')
  write(join(root, 'baseline.txt'), 'baseline\n')
  git(root, 'add', 'baseline.txt')
  git(root, 'commit', '-m', 'baseline')

  const task = startTask({
    schemaVersion: 2,
    taskId,
    implementationOwner: options.implementationOwner ?? 'codex',
    objective: 'Exercise the hardened review and close flow.',
    scope: ['implementation.txt'],
    nonGoals: [],
    authorityInputs: ['spec.md'],
    repositories: [{ id: 'root', path: root }],
    acceptance: [{
      id: 'AC-01',
      observation: 'The contract-owned command succeeds.',
      positiveCases: ['valid implementation'],
      negativeCases: ['failed command'],
      evidenceKind: 'unit',
      command: {
        repositoryId: 'root',
        cwd: '.',
        executable: process.execPath,
        arguments: ['-e', options.commandScript?.(root) ?? "process.stdout.write('passed\\n')"],
      },
      observerPolicy: {
        expectedExitCode: 0,
        output: 'nonempty',
        checkoutMutation: 'forbidden',
        replay: 'not-required',
      },
    }],
    authorizationRequirements: options.authorizationRequirements ?? [],
    extensionInputs: options.extensionInputs,
    evidenceFreshnessMs: 60_000,
    openChoices: [],
    signals: options.signals ?? { security: true },
  }, { projectExtensions: options.projectExtensions })
  for (const artifact of task.artifacts) write(join(root, artifact.path), artifact.content)
  const contractPath = join(root, `.delivery/tasks/${taskId}/contract.yaml`)
  const contractRaw = readFileSync(contractPath)
  const contract = parse(contractRaw.toString('utf8')) as Record<string, unknown>
  if ((contract.contractReadiness as { required?: boolean } | undefined)?.required === true) {
    writeAcceptedContractReadinessReview({
      root,
      taskId,
      contractPath,
      contractRaw,
      contract,
      authorizationRequirements: options.authorizationRequirements,
    })
  }
  const authorizationArtifacts = (options.authorizationDocuments?.({
    root,
    taskId,
    contractDigest: String(contract.contractDigest),
  }) ?? []).map(({ requirementId, document }) => {
    const path = join(root, `.delivery/tasks/${taskId}/authorizations/${requirementId}.json`)
    write(path, `${JSON.stringify(document, null, 2)}\n`)
    return { requirementId, path, sha256: sha256(readFileSync(path)) }
  })
  const inProgress = planTaskTransition({
    projectRoot: root,
    taskId,
    actorId: options.implementationOwner ?? 'codex',
    to: 'IN_PROGRESS',
    artifacts: ((contract.contractReadiness as { required?: boolean } | undefined)?.required === true)
      ? [{ kind: 'contract-review', path: join(root, `.delivery/tasks/${taskId}/contract-review.yaml`) }]
      : [{ kind: 'contract', path: contractPath }],
  })
  if (!applyTaskTransition(inProgress, inProgress.digest).applied) throw new Error('fixture IN_PROGRESS failed')
  write(join(root, 'implementation.txt'), 'implemented\n')
  git(root, 'add', 'implementation.txt')
  git(root, 'commit', '-m', 'implementation')
  const implementationCommit = git(root, 'rev-parse', 'HEAD')
  const implementationTree = git(root, 'rev-parse', 'HEAD^{tree}')
  const receiptPath = join(root, `.delivery/tasks/${taskId}/receipts/run-1/AC-01.json`)
  const receipt = captureCommandExecution({
    schemaVersion: 2,
    projectRoot: root,
    taskId,
    acceptanceId: 'AC-01',
    runId: 'run-1',
  })
  const extensionArtifacts = (options.extensionDocuments?.({
    root,
    taskId,
    contractDigest: String(contract.contractDigest),
  }) ?? []).map(({ extensionId, kind, document }) => {
    const path = join(root, `.delivery/tasks/${taskId}/extensions/${extensionId}/${kind}.json`)
    write(path, `${JSON.stringify(document, null, 2)}\n`)
    return { extensionId, kind, path, sha256: sha256(readFileSync(path)) }
  })
  const identity = governanceIdentity()
  const implementationIdentities = [{
    repositoryId: 'root',
    repository: root,
    commit: implementationCommit,
    tree: implementationTree,
    checkoutDigest: canonicalDigest(receipt.repositoriesBefore[0]),
  }]
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
  const evidencePath = join(root, `.delivery/tasks/${taskId}/evidence.json`)
  write(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`)
  git(root, 'add', '.delivery')
  git(root, 'commit', '-m', 'evidence closure')
  const closureCommit = git(root, 'rev-parse', 'HEAD')
  const candidate = {
    schemaVersion: 2,
    taskId,
    contract: { path: contractPath, sha256: sha256(contractRaw) },
    evidence: { path: evidencePath, sha256: sha256(readFileSync(evidencePath)) },
    implementationIdentities,
    gitIdentities: [{
      repositoryId: 'root',
      repository: root,
      implementationCommit,
      implementationTree,
      closureCommit,
      allowedClosurePaths: ['.delivery/tasks/**'],
    }],
    authorizationArtifacts,
    extensionArtifacts,
  }
  const candidatePath = join(root, `.delivery/tasks/${taskId}/candidate.yaml`)
  write(candidatePath, stringify(candidate))
  const candidatePlan = planTaskTransition({
    projectRoot: root,
    taskId,
    actorId: options.implementationOwner ?? 'codex',
    to: 'CANDIDATE',
    artifacts: [
      { kind: 'candidate', path: candidatePath },
      { kind: 'evidence', path: evidencePath },
      ...authorizationArtifacts.map((artifact) => ({
        kind: `authorization:${artifact.requirementId}`,
        path: artifact.path,
      })),
      ...extensionArtifacts.map((artifact) => ({
        kind: `extension:${artifact.extensionId}:${artifact.kind}`,
        path: artifact.path,
      })),
    ],
  })
  if (!applyTaskTransition(candidatePlan, candidatePlan.digest).applied) {
    throw new Error('fixture CANDIDATE failed')
  }
  const verificationDecision = verifyCandidateEligibility(candidate as never, {
    candidatePath,
    evidenceVerificationTime: new Date(),
  })
  if (!verificationDecision.valid || verificationDecision.verificationArtifact === undefined) {
    throw new Error(`fixture verification failed:${verificationDecision.errors.join(',')}`)
  }
  const verification = verificationDecision.verificationArtifact
  const persisted = persistHardenedVerificationArtifact(verification)
  return {
    root,
    taskId,
    contract,
    contractPath,
    candidate,
    candidatePath,
    evidencePath,
    receiptPath,
    verification,
    verificationPath: persisted.path,
  }
}
