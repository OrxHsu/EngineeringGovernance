import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, expect, it } from 'vitest'
import { parse } from 'yaml'

import { startTask } from '../../src/commands/task-start.js'
import { verifyCandidateEligibility } from '../../src/commands/task-verify.js'

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
  const rawArtifact = `${JSON.stringify({
    schemaVersion: 1,
    runId: 'run-1',
    checks: [{ id: 'test:ac-01', status: 'passed' }],
  })}\n`
  writeFileSync(artifactPath, rawArtifact)
  const evidencePath = join(taskDirectory, 'evidence.json')
  writeFileSync(evidencePath, `${JSON.stringify({
    schemaVersion: 1,
    taskId: 'candidate-task',
    contractDigest: contract.contractDigest,
    runId: 'run-1',
    runnerVersion: '0.1.0-dev',
    implementationCommits: [{
      repository: 'repo',
      commit: implementationCommit,
      tree: implementationTree,
    }],
    records: [{
      acceptanceId: 'AC-01',
      runId: 'run-1',
      executedCheckIds: ['test:ac-01'],
      command: 'pnpm test',
      exitCode: 0,
      startedAt: '2026-07-29T00:00:00Z',
      endedAt: '2026-07-29T00:00:01Z',
      evidenceKind: 'unit',
      implementationIdentities: { repo: implementationCommit },
      rawArtifact: {
        path: '.delivery/tasks/candidate-task/artifacts/unit.json',
        sha256: sha256(rawArtifact),
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
        expectedImplementationIdentities: { repo: implementationCommit },
        verificationTime: '2026-07-29T00:05:00Z',
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
  }
}

it('verifies R2 evidence and Git identity instead of trusting caller summaries', () => {
  const fixture = candidate()
  expect(verifyCandidateEligibility(fixture.input)).toEqual({ valid: true, errors: [] })

  const forgedArtifact = '{"ok":true}\n'
  writeFileSync(fixture.artifactPath, forgedArtifact)
  const evidence = JSON.parse(readFileSync(fixture.evidencePath, 'utf8')) as {
    records: Array<{ rawArtifact: { sha256: string } }>
  }
  evidence.records[0]!.rawArtifact.sha256 = sha256(forgedArtifact)
  writeFileSync(fixture.evidencePath, `${JSON.stringify(evidence, null, 2)}\n`)

  expect(verifyCandidateEligibility(fixture.input).errors).toContain(
    'RAW_ARTIFACT_FORMAT_INVALID:AC-01',
  )
})
