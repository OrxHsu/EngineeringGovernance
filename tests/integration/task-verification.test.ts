import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, expect, it } from 'vitest'
import { parse } from 'yaml'

import { startTask } from '../../src/commands/task-start.js'
import { verifyCandidateEligibility } from '../../src/commands/task-verify.js'
import { canonicalDigest } from '../../src/model/digest.js'

const temporaryDirectories: string[] = []

function git(repository: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: repository, encoding: 'utf8' }).trim()
}

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex')
}

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { recursive: true, force: true })
  }
})

function candidate(): {
  input: Parameters<typeof verifyCandidateEligibility>[0]
  artifactPath: string
  evidencePath: string
  verificationTime: Date
  replayPlanDigest: string
} {
  const repository = mkdtempSync(join(tmpdir(), 'sop-candidate-'))
  temporaryDirectories.push(repository)
  git(repository, 'init', '-b', 'main')
  git(repository, 'config', 'user.email', 'test@example.com')
  git(repository, 'config', 'user.name', 'Test')
  writeFileSync(join(repository, 'implementation.txt'), 'implemented\n')
  git(repository, 'add', 'implementation.txt')
  git(repository, 'commit', '-m', 'implementation')
  const implementationCommit = git(repository, 'rev-parse', 'HEAD')
  const implementationTree = git(repository, 'rev-parse', 'HEAD^{tree}')

  const task = startTask({
    taskId: 'candidate-task',
    implementationOwner: 'codex',
    objective: 'Verify a real candidate.',
    scope: ['implementation.txt'],
    nonGoals: [],
    authorityInputs: ['spec.md'],
    acceptance: [{
      id: 'AC-01',
      observation: 'The named unit check executes.',
      positiveCases: ['passing check'],
      negativeCases: ['missing check'],
    }],
    requiredGates: ['test:ac-01'],
    openChoices: [],
    signals: { crossModule: true },
  })
  const taskDirectory = join(repository, '.delivery', 'tasks', 'candidate-task')
  const artifactDirectory = join(taskDirectory, 'artifacts')
  mkdirSync(artifactDirectory, { recursive: true })
  const contractPath = join(taskDirectory, 'contract.yaml')
  writeFileSync(contractPath, task.artifacts[0]!.content)
  const contract = parse(readFileSync(contractPath, 'utf8')) as { contractDigest: string }

  const artifactPath = join(artifactDirectory, 'unit.json')
  const command = {
    executable: process.execPath,
    arguments: ['-e', "process.stdout.write('test:ac-01 passed\\n')"],
    cwd: repository,
  }
  const checkId = `command:${canonicalDigest(command)}`
  const rawArtifact = `${JSON.stringify({
    schemaVersion: 1,
    artifactType: 'sop-command-execution-v1',
    producer: { name: '@xgh/engineering-governance', version: '1.0.0' },
    runId: 'run-1',
    command,
    startedAt: '2026-07-29T00:00:00Z',
    endedAt: '2026-07-29T00:00:01Z',
    exitCode: 0,
    environment: { node: '22.17.0', platform: process.platform, arch: process.arch },
    stdout: 'test:ac-01 passed\n',
    stderr: '',
    checks: [{ id: checkId, status: 'passed' }],
  })}\n`
  writeFileSync(artifactPath, rawArtifact)
  const evidencePath = join(taskDirectory, 'evidence.json')
  writeFileSync(evidencePath, `${JSON.stringify({
    schemaVersion: 1,
    taskId: 'candidate-task',
    contractDigest: contract.contractDigest,
    runId: 'run-1',
    runnerVersion: '1.0.0',
    implementationCommits: [{
      repository,
      commit: implementationCommit,
      tree: implementationTree,
    }],
    records: [{
      acceptanceId: 'AC-01',
      runId: 'run-1',
      executedCheckIds: [checkId],
      command,
      exitCode: 0,
      startedAt: '2026-07-29T00:00:00Z',
      endedAt: '2026-07-29T00:00:01Z',
      evidenceKind: 'unit',
      implementationIdentities: [{
        repository,
        commit: implementationCommit,
        tree: implementationTree,
      }],
      rawArtifact: {
        path: '.delivery/tasks/candidate-task/artifacts/unit.json',
        sha256: sha256(rawArtifact),
        format: 'sop-command-execution-v1',
      },
      observation: 'The named unit check passed.',
    }],
    summary: { passedIds: ['AC-01'], failedIds: [] },
  }, null, 2)}\n`)
  git(repository, 'add', '.delivery')
  git(repository, 'commit', '-m', 'evidence closure')
  const closureCommit = git(repository, 'rev-parse', 'HEAD')

  return {
    artifactPath,
    evidencePath,
    input: {
      risk: 'R2',
      authorizationRequired: false,
      authorizationApproved: false,
      verification: {
        contractPath,
        evidencePath,
        artifactRoot: repository,
        requiredEvidenceKinds: { 'AC-01': 'unit' },
        expectedImplementationIdentities: [{
          repository,
          commit: implementationCommit,
          tree: implementationTree,
        }],
        maxEvidenceAgeMs: 10 * 60 * 1000,
        gitIdentities: [{
          repository,
          implementationCommit,
          implementationTree,
          closureCommit,
          allowedClosurePaths: ['.delivery/tasks/**'],
        }],
      },
    },
    verificationTime: new Date('2026-07-29T00:05:00Z'),
    replayPlanDigest: canonicalDigest([{ acceptanceId: 'AC-01', command }]),
  }
}

it('requires explicit approval of the exact replay plan before executing evidence commands', () => {
  const fixture = candidate()
  const withoutApproval = verifyCandidateEligibility(fixture.input, {
    evidenceVerificationTime: fixture.verificationTime,
  })
  expect(withoutApproval.errors).toContain(
    `EVIDENCE_REPLAY_APPROVAL_REQUIRED:${fixture.replayPlanDigest}`,
  )

  const wrongApproval = verifyCandidateEligibility(fixture.input, {
    evidenceVerificationTime: fixture.verificationTime,
    evidenceReplayPlanDigest: 'f'.repeat(64),
  })
  expect(wrongApproval.errors).toContain(
    `EVIDENCE_REPLAY_APPROVAL_REQUIRED:${fixture.replayPlanDigest}`,
  )
})

it('verifies R2 evidence and Git identity instead of trusting caller summaries', () => {
  const fixture = candidate()
  const context = {
    evidenceVerificationTime: fixture.verificationTime,
    evidenceReplayPlanDigest: fixture.replayPlanDigest,
  }
  expect(verifyCandidateEligibility(fixture.input, context)).toEqual({ valid: true, errors: [] })

  const forgedArtifact = '{"ok":true}\n'
  writeFileSync(fixture.artifactPath, forgedArtifact)
  const evidence = JSON.parse(readFileSync(fixture.evidencePath, 'utf8')) as {
    records: Array<{ rawArtifact: { sha256: string } }>
  }
  evidence.records[0]!.rawArtifact.sha256 = sha256(forgedArtifact)
  writeFileSync(fixture.evidencePath, `${JSON.stringify(evidence, null, 2)}\n`)

  expect(verifyCandidateEligibility(fixture.input, context).errors).toContain(
    'RAW_ARTIFACT_FORMAT_UNSUPPORTED:AC-01',
  )
})

it('rejects a caller-authored pass list even when its digest matches', () => {
  const fixture = candidate()
  const callerAuthored = `${JSON.stringify({
    schemaVersion: 1,
    runId: 'run-1',
    checks: [{ id: 'test:ac-01', status: 'passed' }],
  })}\n`
  writeFileSync(fixture.artifactPath, callerAuthored)
  const evidence = JSON.parse(readFileSync(fixture.evidencePath, 'utf8')) as {
    records: Array<{ rawArtifact: { sha256: string } }>
  }
  evidence.records[0]!.rawArtifact.sha256 = sha256(callerAuthored)
  writeFileSync(fixture.evidencePath, `${JSON.stringify(evidence, null, 2)}\n`)

  expect(verifyCandidateEligibility(fixture.input, {
    evidenceVerificationTime: fixture.verificationTime,
    evidenceReplayPlanDigest: fixture.replayPlanDigest,
  }).errors).toContain('RAW_ARTIFACT_FORMAT_UNSUPPORTED:AC-01')
})

it('rejects a full-format static receipt when fresh command replay fails', () => {
  const fixture = candidate()
  const evidence = JSON.parse(readFileSync(fixture.evidencePath, 'utf8')) as {
    records: Array<{
      command: { executable: string; arguments: string[]; cwd: string }
      executedCheckIds: string[]
      rawArtifact: { sha256: string }
    }>
  }
  const record = evidence.records[0]!
  const failingCommand = {
    executable: process.execPath,
    arguments: ['-e', 'process.exit(7)'],
    cwd: record.command.cwd,
  }
  const checkId = `command:${canonicalDigest(failingCommand)}`
  const callerAuthored = `${JSON.stringify({
    schemaVersion: 1,
    artifactType: 'sop-command-execution-v1',
    producer: { name: '@xgh/engineering-governance', version: '1.0.0' },
    runId: 'run-1',
    command: failingCommand,
    startedAt: '2026-07-29T00:00:00Z',
    endedAt: '2026-07-29T00:00:01Z',
    exitCode: 0,
    environment: { node: '22.17.0', platform: process.platform, arch: process.arch },
    stdout: 'claimed pass\\n',
    stderr: '',
    checks: [{ id: checkId, status: 'passed' }],
  })}\n`
  writeFileSync(fixture.artifactPath, callerAuthored)
  record.command = failingCommand
  record.executedCheckIds = [checkId]
  record.rawArtifact.sha256 = sha256(callerAuthored)
  writeFileSync(fixture.evidencePath, `${JSON.stringify(evidence, null, 2)}\n`)

  expect(verifyCandidateEligibility(fixture.input, {
    evidenceVerificationTime: fixture.verificationTime,
    evidenceReplayPlanDigest: canonicalDigest([{ acceptanceId: 'AC-01', command: failingCommand }]),
  }).errors).toContain('RAW_EXECUTION_REPLAY_FAILED:AC-01:7')
})

it('rejects caller-controlled evidence time and unbounded freshness windows', () => {
  const fixture = candidate()
  const verification = fixture.input.verification as unknown as Record<string, unknown>
  verification.verificationTime = '2026-07-29T00:05:00Z'
  verification.maxEvidenceAgeMs = 7 * 24 * 60 * 60 * 1000

  const errors = verifyCandidateEligibility(fixture.input, {
    evidenceVerificationTime: fixture.verificationTime,
    evidenceReplayPlanDigest: fixture.replayPlanDigest,
  }).errors
  expect(errors).toContain('EVIDENCE_VERIFICATION_TIME_CALLER_CONTROLLED')
  expect(errors).toContain('EVIDENCE_MAX_AGE_EXCEEDS_POLICY')
})

it('rejects forged implementation trees and incomplete Git identity sets', () => {
  const fixture = candidate()
  const secondRepository = mkdtempSync(join(tmpdir(), 'sop-candidate-second-'))
  temporaryDirectories.push(secondRepository)
  git(secondRepository, 'init', '-b', 'main')
  git(secondRepository, 'config', 'user.email', 'test@example.com')
  git(secondRepository, 'config', 'user.name', 'Test')
  writeFileSync(join(secondRepository, 'implementation.txt'), 'second implementation\n')
  git(secondRepository, 'add', 'implementation.txt')
  git(secondRepository, 'commit', '-m', 'second implementation')
  const secondCommit = git(secondRepository, 'rev-parse', 'HEAD')
  const secondTree = git(secondRepository, 'rev-parse', 'HEAD^{tree}')
  const verification = fixture.input.verification!
  verification.expectedImplementationIdentities.push({
    repository: secondRepository,
    commit: secondCommit,
    tree: secondTree,
  })
  verification.gitIdentities.push({
    repository: secondRepository,
    implementationCommit: secondCommit,
    implementationTree: secondTree,
    closureCommit: secondCommit,
    allowedClosurePaths: [],
  })
  const evidence = JSON.parse(readFileSync(fixture.evidencePath, 'utf8')) as {
    implementationCommits: Array<{ repository: string; commit: string; tree: string }>
    records: Array<{
      implementationIdentities: Array<{ repository: string; commit: string; tree: string }>
    }>
  }
  const secondIdentity = { repository: secondRepository, commit: secondCommit, tree: secondTree }
  evidence.implementationCommits.push(secondIdentity)
  evidence.records[0]!.implementationIdentities.push(secondIdentity)
  writeFileSync(fixture.evidencePath, `${JSON.stringify(evidence, null, 2)}\n`)
  const context = {
    evidenceVerificationTime: fixture.verificationTime,
    evidenceReplayPlanDigest: fixture.replayPlanDigest,
  }
  expect(verifyCandidateEligibility(fixture.input, context)).toEqual({ valid: true, errors: [] })

  evidence.implementationCommits[1]!.tree = 'f'.repeat(40)
  writeFileSync(fixture.evidencePath, `${JSON.stringify(evidence, null, 2)}\n`)
  expect(verifyCandidateEligibility(fixture.input, context).errors).toContain(
    'IMPLEMENTATION_IDENTITY_SET_MISMATCH',
  )

  evidence.implementationCommits[1]!.tree = secondTree
  writeFileSync(fixture.evidencePath, `${JSON.stringify(evidence, null, 2)}\n`)
  verification.gitIdentities.pop()
  expect(verifyCandidateEligibility(fixture.input, context).errors).toContain(
    'GIT_IDENTITY_SET_MISMATCH',
  )
})
