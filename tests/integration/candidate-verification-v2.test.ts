import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import { parse, stringify } from 'yaml'

import { governanceIdentity } from '../../src/commands/adopt.js'
import { startTask } from '../../src/commands/task-start.js'
import { verifyCandidateEligibility } from '../../src/commands/task-verify.js'
import { persistHardenedVerificationArtifact } from '../../src/commands/task-verify-v2.js'
import { applyCandidateReplay, planCandidateReplay } from '../../src/commands/task-replay-v2.js'
import { captureCommandExecution } from '../../src/evidence/capture.js'
import { canonicalDigest } from '../../src/model/digest.js'
import { applyTaskTransition, planTaskTransition } from '../../src/state/ledger.js'
import { writeAcceptedContractReadinessReview } from '../helpers/hardened-task.js'

const temporaryDirectories: string[] = []

function sha256(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex')
}

function git(repository: string, ...arguments_: string[]): string {
  return execFileSync('git', ['-C', repository, ...arguments_], { encoding: 'utf8' }).trim()
}

function write(path: string, content: string): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content)
}

function fixture(
  replay: 'required' | 'not-required' = 'not-required',
  authorization: 'none' | 'standard' | 'remediation' = 'none',
): {
  candidate: Record<string, unknown>
  candidatePath: string
  evidencePath: string
  evidenceContent: string
  receiptPath: string
} {
  const createdRepository = mkdtempSync(join(tmpdir(), 'sop-v2-candidate-'))
  temporaryDirectories.push(createdRepository)
  const repository = realpathSync(createdRepository)
  git(repository, 'init', '-b', 'main')
  git(repository, 'config', 'user.email', 'test@example.com')
  git(repository, 'config', 'user.name', 'Test')
  write(join(repository, 'implementation.txt'), 'implemented\n')
  git(repository, 'add', 'implementation.txt')
  git(repository, 'commit', '-m', 'implementation')
  const implementationCommit = git(repository, 'rev-parse', 'HEAD')
  const implementationTree = git(repository, 'rev-parse', 'HEAD^{tree}')

  const task = startTask({
    schemaVersion: 2,
    taskId: 'candidate-v2',
    implementationOwner: 'codex',
    objective: 'Verify an exact v2 candidate.',
    scope: ['implementation.txt'],
    nonGoals: [],
    authorityInputs: ['spec.md'],
    repositories: [{ id: 'root', path: repository }],
    acceptance: [{
      id: 'AC-01',
      observation: 'The exact unit command passes.',
      positiveCases: ['passing implementation'],
      negativeCases: ['failed command'],
      evidenceKind: 'unit',
      command: {
        repositoryId: 'root',
        cwd: '.',
        executable: process.execPath,
        arguments: ['-e', "process.stdout.write('unit passed\\n')"],
      },
      observerPolicy: {
        expectedExitCode: 0,
        output: 'nonempty',
        checkoutMutation: 'forbidden',
        replay,
      },
    }],
    authorizationRequirements: authorization !== 'none' ? [{
      id: 'AUTH-CANDIDATE-REMEDIATION',
      action: 'verify-remediation-candidate',
      target: repository,
      scope: ['candidate-v2'],
      trustLevel: 'recorded-claim',
      consumeOnce: true,
    }] : [],
    evidenceFreshnessMs: 60_000,
    openChoices: [],
    signals: { mutation: true, crossModule: true },
  })
  for (const artifact of task.artifacts) write(join(repository, artifact.path), artifact.content)
  const contractPath = join(repository, task.artifacts[0]!.path)
  const contractContent = readFileSync(contractPath, 'utf8')
  const contract = parse(contractContent) as { contractDigest: string }
  const authorizationPath = join(
    repository,
    '.delivery/tasks/candidate-v2/authorizations/AUTH-CANDIDATE-REMEDIATION.json',
  )
  if (authorization !== 'none') {
    write(authorizationPath, `${JSON.stringify({
      schemaVersion: 2,
      artifactType: authorization === 'standard' ? 'sop-authorization-v2' : 'engineering-governance-remediation-authorization-v1',
      authorizationId: authorization === 'standard' ? 'candidate-remediation-authorization' : 'AUTH-CANDIDATE-REMEDIATION',
      requirementId: 'AUTH-CANDIDATE-REMEDIATION',
      taskId: 'candidate-v2',
      ...(authorization === 'standard' ? { contractDigest: contract.contractDigest } : { contract: {
        path: contractPath,
        rawSha256: sha256(contractContent),
        semanticDigest: contract.contractDigest,
      } }),
      grantor: { id: 'user-authority', role: 'user', trustLevel: 'local-claim' },
      action: 'verify-remediation-candidate',
      target: repository,
      scope: ['candidate-v2'],
      ...(authorization === 'standard' ? {} : {
        supervisorId: 'user-authority',
        contractReviewerId: 'contract-reviewer',
        implementationReviewerId: 'implementation-reviewer',
      }),
      issuedAt: new Date(Date.now() - 60_000).toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      ...(authorization === 'standard' ? {} : { consumeOnce: true }),
      status: 'approved',
    }, null, 2)}\n`)
  }
  writeAcceptedContractReadinessReview({
    root: repository,
    taskId: 'candidate-v2',
    contractPath,
    contractRaw: contractContent,
    contract: contract as Record<string, unknown>,
  })
  const receiptPath = join(repository, '.delivery/tasks/candidate-v2/receipts/run-1/AC-01.json')
  const receipt = captureCommandExecution({
    schemaVersion: 2,
    projectRoot: repository,
    taskId: 'candidate-v2',
    acceptanceId: 'AC-01',
    runId: 'run-1',
  })
  const identity = governanceIdentity()
  const evidence = {
    schemaVersion: 2,
    artifactType: 'sop-evidence-v2',
    taskId: 'candidate-v2',
    contractDigest: contract.contractDigest,
    runId: 'run-1',
    runner: { version: identity.version, policyDigest: identity.digest },
    implementationIdentities: [{
      repositoryId: 'root',
      repository,
      commit: implementationCommit,
      tree: implementationTree,
      checkoutDigest: canonicalDigest(receipt.repositoriesBefore[0]),
    }],
    receipts: [{
      acceptanceId: 'AC-01',
      path: '.delivery/tasks/candidate-v2/receipts/run-1/AC-01.json',
      sha256: sha256(readFileSync(receiptPath)),
    }],
    summary: { passedIds: ['AC-01'], failedIds: [] },
  }
  const evidencePath = join(repository, '.delivery/tasks/candidate-v2/evidence.json')
  const evidenceContent = `${JSON.stringify(evidence, null, 2)}\n`
  write(evidencePath, evidenceContent)
  git(repository, 'add', '.delivery')
  git(repository, 'commit', '-m', 'evidence closure')
  const closureCommit = git(repository, 'rev-parse', 'HEAD')

  const candidate = {
    schemaVersion: 2,
    taskId: 'candidate-v2',
    contract: { path: contractPath, sha256: sha256(contractContent) },
    evidence: { path: evidencePath, sha256: sha256(evidenceContent) },
    implementationIdentities: evidence.implementationIdentities,
    gitIdentities: [{
      repositoryId: 'root',
      repository,
      implementationCommit,
      implementationTree,
      closureCommit,
      allowedClosurePaths: ['.delivery/tasks/**'],
    }],
    authorizationArtifacts: authorization !== 'none' ? [{
      requirementId: 'AUTH-CANDIDATE-REMEDIATION',
      path: authorizationPath,
      sha256: sha256(readFileSync(authorizationPath)),
    }] : [],
    extensionArtifacts: [],
  }
  const candidatePath = join(repository, '.delivery/tasks/candidate-v2/candidate.yaml')
  write(candidatePath, stringify(candidate))
  const inProgress = planTaskTransition({
    projectRoot: repository,
    taskId: 'candidate-v2',
    actorId: 'codex',
    to: 'IN_PROGRESS',
    artifacts: [{ kind: 'contract-review', path: join(repository, '.delivery/tasks/candidate-v2/contract-review.yaml') }],
  })
  if (!applyTaskTransition(inProgress, inProgress.digest).applied) throw new Error('fixture transition failed')
  const candidateTransition = planTaskTransition({
    projectRoot: repository,
    taskId: 'candidate-v2',
    actorId: 'codex',
    to: 'CANDIDATE',
    artifacts: [
      { kind: 'candidate', path: candidatePath },
      { kind: 'evidence', path: evidencePath },
      ...(authorization !== 'none' ? [{
        kind: 'authorization:AUTH-CANDIDATE-REMEDIATION',
        path: authorizationPath,
      }] : []),
    ],
  })
  if (!applyTaskTransition(candidateTransition, candidateTransition.digest).applied) {
    throw new Error('fixture candidate transition failed')
  }
  return { candidate, candidatePath, evidencePath, evidenceContent, receiptPath }
}

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { recursive: true, force: true })
  }
})

describe('v2 candidate verification', () => {
  it('statically binds contract, evidence, receipts, checkout identity, and Git closure', () => {
    const value = fixture()
    const decision = verifyCandidateEligibility(value.candidate as never, {
      candidatePath: value.candidatePath,
      evidenceVerificationTime: new Date(),
    })

    expect(decision.errors).toEqual([])
    expect(decision.valid).toBe(true)
    expect(decision.verificationArtifact).toMatchObject({
      schemaVersion: 2,
      artifactType: 'sop-candidate-verification-v2',
      taskId: 'candidate-v2',
      decision: 'eligible',
      candidate: { path: value.candidatePath },
      evidence: { path: value.evidencePath, sha256: sha256(value.evidenceContent) },
      receipts: [{ path: value.receiptPath, sha256: sha256(readFileSync(value.receiptPath)) }],
    })
    const persisted = persistHardenedVerificationArtifact(decision.verificationArtifact!)
    expect(persisted.path).toBe(join(dirname(value.candidatePath), 'verification.json'))
    expect(persisted.sha256).toBe(sha256(readFileSync(persisted.path)))
    expect(() => persistHardenedVerificationArtifact(decision.verificationArtifact!)).toThrow(
      'VERIFICATION_ARTIFACT_ALREADY_EXISTS',
    )
  })

  it('accepts a standard lifecycle authorization consumed exactly once', () => {
    const value = fixture('not-required', 'standard')
    const decision = verifyCandidateEligibility(value.candidate as never, {
      candidatePath: value.candidatePath,
      evidenceVerificationTime: new Date(),
    })

    expect(decision.errors).toEqual([])
    expect(decision.valid).toBe(true)
    expect(decision.verificationArtifact?.authorizationTrust).toEqual([{
      requirementId: 'AUTH-CANDIDATE-REMEDIATION',
      trustLevel: 'local-claim',
    }])
  })

  it('rejects a remediation sidecar when supplied as a candidate authorization', () => {
    const value = fixture('not-required', 'remediation')
    const decision = verifyCandidateEligibility(value.candidate as never, {
      candidatePath: value.candidatePath,
      evidenceVerificationTime: new Date(),
    })

    expect(decision.valid).toBe(false)
    expect(decision.errors).toContain('AUTHORIZATION_SCHEMA_INVALID:AUTH-CANDIDATE-REMEDIATION')
  })

  it('rejects post-candidate evidence substitution and candidate-owned gate requirements', () => {
    const substituted = fixture()
    writeFileSync(substituted.evidencePath, `${substituted.evidenceContent.trim()} \n`)
    expect(verifyCandidateEligibility(substituted.candidate as never, {
      candidatePath: substituted.candidatePath,
      evidenceVerificationTime: new Date(),
    }).errors).toContain('EVIDENCE_ARTIFACT_DIGEST_MISMATCH')

    const invented = fixture()
    invented.candidate.requiredEvidenceKinds = { 'AC-01': 'static' }
    writeFileSync(invented.candidatePath, stringify(invented.candidate))
    expect(verifyCandidateEligibility(invented.candidate as never, {
      candidatePath: invented.candidatePath,
      evidenceVerificationTime: new Date(),
    }).errors.join('\n')).toContain('CANDIDATE_SCHEMA_INVALID')

    const wrongCheckout = fixture()
    const identities = wrongCheckout.candidate.implementationIdentities as Array<Record<string, unknown>>
    identities[0]!.checkoutDigest = '0'.repeat(64)
    writeFileSync(wrongCheckout.candidatePath, stringify(wrongCheckout.candidate))
    expect(verifyCandidateEligibility(wrongCheckout.candidate as never, {
      candidatePath: wrongCheckout.candidatePath,
      evidenceVerificationTime: new Date(),
    }).errors).toContain('RECEIPT_IMPLEMENTATION_IDENTITY_MISMATCH:AC-01')

    const wrongState = fixture()
    const ledgerPath = join(dirname(wrongState.candidatePath), 'ledger.jsonl')
    const ledgerLines = readFileSync(ledgerPath, 'utf8').trim().split('\n')
    writeFileSync(ledgerPath, `${ledgerLines.slice(0, 2).join('\n')}\n`)
    expect(verifyCandidateEligibility(wrongState.candidate as never, {
      candidatePath: wrongState.candidatePath,
      evidenceVerificationTime: new Date(),
    }).errors).toContain('TASK_STATE_NOT_CANDIDATE:IN_PROGRESS')
  }, 60_000)

  it('requires a separately approved contract-owned replay and binds its artifact', () => {
    const value = fixture('required')
    const plan = planCandidateReplay(value.candidatePath)
    const before = verifyCandidateEligibility(value.candidate as never, {
      candidatePath: value.candidatePath,
      evidenceVerificationTime: new Date(),
    })
    expect(before.errors).toContain(`EVIDENCE_REPLAY_APPROVAL_REQUIRED:${plan.digest}`)

    expect(() => applyCandidateReplay(plan, '0'.repeat(64))).toThrow('REPLAY_PLAN_DIGEST_MISMATCH')
    const replay = applyCandidateReplay(plan, plan.digest)
    expect(replay.artifact.decision).toBe('eligible')
    const after = verifyCandidateEligibility(value.candidate as never, {
      candidatePath: value.candidatePath,
      evidenceVerificationTime: new Date(),
    })
    expect(after.errors).toEqual([])
    expect(after.valid).toBe(true)
    expect(after.verificationArtifact?.replay).toMatchObject({
      path: replay.path,
      planDigest: plan.digest,
    })
  })
})
