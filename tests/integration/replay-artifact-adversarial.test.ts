import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import { parse, stringify } from 'yaml'

import { startTask } from '../../src/commands/task-start.js'
import {
  applyCandidateReplay,
  planCandidateReplay,
  verifyCandidateReplay,
  type CandidateReplayPlan,
  type ReplayVerificationArtifact,
} from '../../src/commands/task-replay-v2.js'
import { captureCheckoutSnapshot } from '../../src/evidence/checkout-snapshot.js'
import { canonicalDigest } from '../../src/model/digest.js'
import { applyTaskTransition, planTaskTransition } from '../../src/state/ledger.js'
import { writeAcceptedContractReadinessReview } from '../helpers/hardened-task.js'

const temporaryDirectories: string[] = []

function sha256(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex')
}

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

function git(repository: string, ...arguments_: string[]): string {
  return execFileSync('git', ['-C', repository, ...arguments_], { encoding: 'utf8' }).trim()
}

interface ReplayedFixture {
  artifact: ReplayVerificationArtifact
  artifactPath: string
  candidatePath: string
  plan: CandidateReplayPlan
}

function replayedFixture(): ReplayedFixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'sop-replay-adversarial-')))
  temporaryDirectories.push(root)
  git(root, 'init', '-b', 'main')
  git(root, 'config', 'user.email', 'test@example.com')
  git(root, 'config', 'user.name', 'Test')
  write(join(root, 'implementation.txt'), 'implemented\n')
  git(root, 'add', 'implementation.txt')
  git(root, 'commit', '-m', 'implementation')
  const implementationCommit = git(root, 'rev-parse', 'HEAD')
  const implementationTree = git(root, 'rev-parse', 'HEAD^{tree}')

  const gates = [
    { id: 'AC-01', output: 'alpha\n' },
    { id: 'AC-02', output: 'beta\n' },
  ]
  const task = startTask({
    schemaVersion: 2,
    taskId: 'replay-adversarial',
    implementationOwner: 'codex',
    objective: 'Verify replay artifacts independently of candidate-authored claims.',
    scope: ['implementation.txt'],
    nonGoals: [],
    authorityInputs: ['synthetic-test-contract'],
    repositories: [{ id: 'root', path: root }],
    acceptance: gates.map((gate) => ({
      id: gate.id,
      observation: `${gate.id} emits the frozen exact output.`,
      positiveCases: ['exact local output'],
      negativeCases: ['forged replay result'],
      evidenceKind: 'integration',
      command: {
        repositoryId: 'root',
        cwd: '.',
        executable: process.execPath,
        arguments: ['-e', `process.stdout.write(${JSON.stringify(gate.output)})`],
      },
      observerPolicy: {
        expectedExitCode: 0,
        output: 'exact' as const,
        expectedStdoutSha256: sha256(gate.output),
        expectedStderrSha256: sha256(''),
        checkoutMutation: 'forbidden' as const,
        replay: 'required' as const,
      },
    })),
    authorizationRequirements: [],
    evidenceFreshnessMs: 60_000,
    openChoices: [],
    signals: { security: true },
  })
  for (const artifact of task.artifacts) write(join(root, artifact.path), artifact.content)
  const contractPath = join(root, task.artifacts.find((artifact) => (
    artifact.path.endsWith('/contract.yaml')
  ))!.path)
  const contractRaw = readFileSync(contractPath)
  const contract = parse(contractRaw.toString('utf8')) as { contractDigest: string }
  writeAcceptedContractReadinessReview({
    root,
    taskId: 'replay-adversarial',
    contractPath,
    contractRaw,
    contract: contract as Record<string, unknown>,
  })

  const snapshot = captureCheckoutSnapshot({ id: 'root', path: root })
  const implementationIdentities = [{
    repositoryId: 'root',
    repository: root,
    commit: implementationCommit,
    tree: implementationTree,
    checkoutDigest: canonicalDigest(snapshot),
  }]
  const evidencePath = join(root, '.delivery/tasks/replay-adversarial/evidence.json')
  const evidence = {
    schemaVersion: 2,
    artifactType: 'sop-evidence-v2',
    taskId: 'replay-adversarial',
    contractDigest: contract.contractDigest,
    runId: 'synthetic-run',
    runner: { version: 'synthetic', policyDigest: '0'.repeat(64) },
    implementationIdentities,
    receipts: gates.map((gate) => ({
      acceptanceId: gate.id,
      path: `.delivery/tasks/replay-adversarial/receipts/synthetic/${gate.id}.json`,
      sha256: '0'.repeat(64),
    })),
    summary: { passedIds: gates.map((gate) => gate.id), failedIds: [] },
  }
  write(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`)
  const candidatePath = join(root, '.delivery/tasks/replay-adversarial/candidate.yaml')
  write(candidatePath, stringify({
    schemaVersion: 2,
    taskId: 'replay-adversarial',
    contract: { path: contractPath, sha256: sha256(contractRaw) },
    evidence: { path: evidencePath, sha256: sha256(readFileSync(evidencePath)) },
    implementationIdentities,
    gitIdentities: [{
      repositoryId: 'root',
      repository: root,
      implementationCommit,
      implementationTree,
      closureCommit: implementationCommit,
      allowedClosurePaths: ['.delivery/tasks/**'],
    }],
    authorizationArtifacts: [],
    extensionArtifacts: [],
  }))

  const inProgress = planTaskTransition({
    projectRoot: root,
    taskId: 'replay-adversarial',
    actorId: 'codex',
    to: 'IN_PROGRESS',
    artifacts: [{ kind: 'contract-review', path: join(root, '.delivery/tasks/replay-adversarial/contract-review.yaml') }],
  })
  expect(applyTaskTransition(inProgress, inProgress.digest)).toEqual({ applied: true, errors: [] })
  const candidate = planTaskTransition({
    projectRoot: root,
    taskId: 'replay-adversarial',
    actorId: 'codex',
    to: 'CANDIDATE',
    artifacts: [
      { kind: 'candidate', path: candidatePath },
      { kind: 'evidence', path: evidencePath },
    ],
  })
  expect(applyTaskTransition(candidate, candidate.digest)).toEqual({ applied: true, errors: [] })

  const plan = planCandidateReplay(candidatePath)
  const replay = applyCandidateReplay(plan, plan.digest)
  expect(verifyCandidateReplay(candidatePath, new Date(), 60_000).errors).toEqual([])
  return { artifact: replay.artifact, artifactPath: replay.path, candidatePath, plan }
}

function persist(fixture: ReplayedFixture): void {
  writeFileSync(fixture.artifactPath, `${JSON.stringify(fixture.artifact, null, 2)}\n`)
}

function errors(fixture: ReplayedFixture): string[] {
  persist(fixture)
  return verifyCandidateReplay(fixture.candidatePath, new Date(), 60_000).errors
}

function replaceApprovedSnapshots(
  fixture: ReplayedFixture,
  snapshots: CandidateReplayPlan['checkoutSnapshots'],
): void {
  const { digest: _digest, ...unsigned } = fixture.plan
  fixture.artifact.planDigest = canonicalDigest({ ...unsigned, checkoutSnapshots: snapshots })
}

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('replay artifact adversarial integrity', () => {
  it('rejects an incorrect exit code even when policyErrors is forged empty', () => {
    const fixture = replayedFixture()
    fixture.artifact.executions[0]!.exitCode = 7
    fixture.artifact.executions[0]!.policyErrors = []
    expect(errors(fixture)).toContain('REPLAY_EXIT_CODE_MISMATCH:AC-01')
  })

  it('rejects forged policyErrors rather than trusting them as an observer result', () => {
    const fixture = replayedFixture()
    fixture.artifact.executions[0]!.exitCode = 7
    fixture.artifact.executions[0]!.policyErrors = ['FORGED_POLICY_CLEARANCE']
    expect(errors(fixture)).toContain('REPLAY_POLICY_ERROR:AC-01:FORGED_POLICY_CLEARANCE')
  })

  it('rejects stdout and stderr whose recorded digests do not match', () => {
    const fixture = replayedFixture()
    fixture.artifact.executions[0]!.stdout = 'forged stdout\n'
    fixture.artifact.executions[0]!.stderr = 'forged stderr\n'
    expect(errors(fixture)).toContain('REPLAY_OUTPUT_DIGEST_MISMATCH:AC-01')
  })

  it('rejects forged stdout and stderr even when their internal digests are recomputed', () => {
    const fixture = replayedFixture()
    const execution = fixture.artifact.executions[0]!
    execution.stdout = 'forged stdout\n'
    execution.stderr = 'forged stderr\n'
    execution.stdoutSha256 = sha256(execution.stdout)
    execution.stderrSha256 = sha256(execution.stderr)
    expect(errors(fixture)).toContain('REPLAY_OUTPUT_POLICY_MISMATCH:AC-01')
  })

  it('rejects replay snapshots supplied by the execution artifact as the approved plan', () => {
    const fixture = replayedFixture()
    const forged = structuredClone(fixture.artifact.executions[0]!.repositoriesBefore)
    forged[0]!.head = 'f'.repeat(40)
    forged[0]!.tree = 'e'.repeat(40)
    for (const execution of fixture.artifact.executions) {
      execution.repositoriesBefore = structuredClone(forged)
      execution.repositoriesAfter = structuredClone(forged)
    }
    replaceApprovedSnapshots(fixture, forged)
    expect(errors(fixture)).toContain('REPLAY_APPROVED_PLAN_REQUIRED')
  })

  it('rejects a missing replay execution', () => {
    const fixture = replayedFixture()
    fixture.artifact.executions.pop()
    expect(errors(fixture)).toContain('REPLAY_EXECUTION_SET_MISMATCH')
  })

  it('rejects duplicated replay executions', () => {
    const fixture = replayedFixture()
    fixture.artifact.executions[1] = structuredClone(fixture.artifact.executions[0]!)
    expect(errors(fixture)).toContain('REPLAY_EXECUTION_BINDING_MISMATCH:AC-02')
  })

  it('rejects reordered replay executions', () => {
    const fixture = replayedFixture()
    fixture.artifact.executions.reverse()
    expect(errors(fixture)).toContain('REPLAY_EXECUTION_BINDING_MISMATCH:AC-01')
  })

  it('rejects a substituted replay execution', () => {
    const fixture = replayedFixture()
    fixture.artifact.executions[1]!.acceptanceId = 'AC-FORGED'
    expect(errors(fixture)).toContain('REPLAY_EXECUTION_BINDING_MISMATCH:AC-02')
  })

  it('rejects a changed replay plan digest', () => {
    const fixture = replayedFixture()
    fixture.artifact.planDigest = '0'.repeat(64)
    expect(errors(fixture)).toContain('REPLAY_PLAN_BINDING_MISMATCH')
  })

  it('rejects a changed gate digest', () => {
    const fixture = replayedFixture()
    fixture.artifact.executions[0]!.gateDigest = '0'.repeat(64)
    expect(errors(fixture)).toContain('REPLAY_EXECUTION_BINDING_MISMATCH:AC-01')
  })

  it('rejects a changed command', () => {
    const fixture = replayedFixture()
    fixture.artifact.executions[0]!.command.arguments.push('--forged')
    expect(errors(fixture)).toContain('REPLAY_EXECUTION_BINDING_MISMATCH:AC-01')
  })

  it('rejects a changed repository set', () => {
    const fixture = replayedFixture()
    const forged = structuredClone(fixture.artifact.executions[0]!.repositoriesBefore)
    forged.push({ ...structuredClone(forged[0]!), id: 'shadow' })
    for (const execution of fixture.artifact.executions) {
      execution.repositoriesBefore = structuredClone(forged)
      execution.repositoriesAfter = structuredClone(forged)
    }
    replaceApprovedSnapshots(fixture, forged)
    expect(errors(fixture)).toContain('REPLAY_REPOSITORY_SET_MISMATCH')
  })

  it('rejects changed checkout state across an execution', () => {
    const fixture = replayedFixture()
    fixture.artifact.executions[0]!.repositoriesAfter[0]!.head = 'f'.repeat(40)
    expect(errors(fixture)).toContain('REPLAY_CHECKOUT_MUTATED:AC-01')
  })
})
