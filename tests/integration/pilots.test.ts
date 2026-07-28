import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  existsSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { parse, stringify } from 'yaml'
import { afterEach, describe, expect, it } from 'vitest'

const temporaryDirectories: string[] = []
const executable = join(process.cwd(), 'node_modules', '.bin', 'tsx')

interface CliResult {
  status: number | null
  stdout: string
  stderr: string
  json: Record<string, unknown>
}

interface CandidateState {
  implementationCommit: string
  implementationTree: string
  closureCommit: string
  verification: Record<string, unknown>
}

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex')
}

function git(repository: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: repository, encoding: 'utf8' }).trim()
}

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

function runCli(arguments_: string[]): CliResult {
  const result = spawnSync(executable, ['src/cli/main.ts', ...arguments_], {
    cwd: process.cwd(),
    encoding: 'utf8',
  })
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    json: result.stdout.trim().length === 0
      ? {}
      : JSON.parse(result.stdout) as Record<string, unknown>,
  }
}

function runInput(command: string[], input: unknown, directory: string): CliResult {
  const path = join(directory, `input-${Math.random().toString(16).slice(2)}.yaml`)
  write(path, stringify(input))
  return runCli([...command, '--input', path])
}

function repository(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix))
  temporaryDirectories.push(path)
  git(path, 'init', '-b', 'main')
  git(path, 'config', 'user.email', 'pilot@example.com')
  git(path, 'config', 'user.name', 'Pilot')
  return path
}

function commitImplementation(repositoryPath: string, path: string, content: string): {
  commit: string
  tree: string
} {
  write(join(repositoryPath, path), content)
  git(repositoryPath, 'add', '--', path)
  git(repositoryPath, 'commit', '-m', `implementation ${content.trim()}`)
  return {
    commit: git(repositoryPath, 'rev-parse', 'HEAD'),
    tree: git(repositoryPath, 'rev-parse', 'HEAD^{tree}'),
  }
}

function closeEvidence(options: {
  repositoryPath: string
  taskId: string
  contractContent: string
  acceptanceId: string
  checkId: string
  implementationCommit: string
  implementationTree: string
  runId: string
  evidenceKind: 'unit' | 'integration'
}): CandidateState {
  const taskRoot = join(options.repositoryPath, '.delivery', 'tasks', options.taskId)
  const contractPath = join(taskRoot, 'contract.yaml')
  if (!existsSync(contractPath)) write(contractPath, options.contractContent)
  const contract = parse(readFileSync(contractPath, 'utf8')) as { contractDigest: string }
  const rawArtifact = `${JSON.stringify({
    schemaVersion: 1,
    runId: options.runId,
    checks: [{ id: options.checkId, status: 'passed' }],
  })}\n`
  const artifactPath = join(taskRoot, 'artifacts', `${options.runId}.json`)
  write(artifactPath, rawArtifact)
  const evidencePath = join(taskRoot, 'evidence.json')
  write(evidencePath, `${JSON.stringify({
    schemaVersion: 1,
    taskId: options.taskId,
    contractDigest: contract.contractDigest,
    runId: options.runId,
    runnerVersion: '0.1.0-dev',
    implementationCommits: [{
      repository: 'pilot-repo',
      commit: options.implementationCommit,
      tree: options.implementationTree,
    }],
    records: [{
      acceptanceId: options.acceptanceId,
      runId: options.runId,
      executedCheckIds: [options.checkId],
      command: options.checkId,
      exitCode: 0,
      startedAt: '2026-07-29T00:10:00Z',
      endedAt: '2026-07-29T00:10:01Z',
      evidenceKind: options.evidenceKind,
      implementationIdentities: { 'pilot-repo': options.implementationCommit },
      rawArtifact: {
        path: `.delivery/tasks/${options.taskId}/artifacts/${options.runId}.json`,
        sha256: sha256(rawArtifact),
      },
      observation: 'The named pilot check executed successfully.',
    }],
    summary: { passedIds: [options.acceptanceId], failedIds: [] },
  }, null, 2)}\n`)
  git(options.repositoryPath, 'add', '--', '.delivery')
  git(options.repositoryPath, 'commit', '-m', `evidence closure ${options.runId}`)
  const closureCommit = git(options.repositoryPath, 'rev-parse', 'HEAD')
  return {
    implementationCommit: options.implementationCommit,
    implementationTree: options.implementationTree,
    closureCommit,
    verification: {
      contractPath,
      evidencePath,
      artifactRoot: options.repositoryPath,
      requiredEvidenceKinds: { [options.acceptanceId]: options.evidenceKind },
      expectedImplementationIdentities: { 'pilot-repo': options.implementationCommit },
      verificationTime: '2026-07-29T00:15:00Z',
      maxEvidenceAgeMs: 10 * 60 * 1000,
      gitIdentities: [{
        repository: options.repositoryPath,
        implementationCommit: options.implementationCommit,
        implementationTree: options.implementationTree,
        closureCommit,
        allowedClosurePaths: ['.delivery/tasks/**'],
      }],
    },
  }
}

function startPilot(path: string): Record<string, unknown> {
  const result = runCli(['task', 'start', '--input', path])
  expect(result.status, result.stderr).toBe(0)
  return result.json
}

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('real CLI workflow pilots', () => {
  it('keeps R1 lightweight while requiring a fresh local test', () => {
    const start = startPilot('tests/pilots/r1-local/start.yaml')
    expect(start).toMatchObject({ risk: 'R1', state: 'DEFINED', artifacts: [] })

    const project = repository('sop-r1-pilot-')
    write(join(project, 'behavior.mjs'), 'export const answer = () => 42\n')
    write(
      join(project, 'behavior.test.mjs'),
      "import assert from 'node:assert/strict'\nimport test from 'node:test'\nimport { answer } from './behavior.mjs'\ntest('answer', () => assert.equal(answer(), 42))\n",
    )
    const testResult = spawnSync(process.execPath, ['--test', 'behavior.test.mjs'], {
      cwd: project,
      encoding: 'utf8',
    })
    expect(testResult.status, testResult.stderr || testResult.stdout).toBe(0)
    expect(existsSync(join(
      project,
      '.delivery',
      'tasks',
      'pilot-r1-local',
      'contract.yaml',
    ))).toBe(false)
    const verification = runInput(['task', 'verify'], {
      risk: 'R1',
      requiredGateErrors: [],
      authorizationRequired: false,
      authorizationApproved: false,
    }, project)
    expect(verification.status, verification.stderr).toBe(0)
    expect(verification.json).toEqual({ valid: true, errors: [] })
  })

  it('forces R2 repair by the original owner before independent acceptance', () => {
    const start = startPilot('tests/pilots/r2-review/start.yaml')
    expect(start).toMatchObject({ risk: 'R2', state: 'DEFINED' })
    const contractContent = (start.artifacts as Array<{ content: string }>)[0]!.content
    const project = repository('sop-r2-pilot-')

    const violating = commitImplementation(project, 'boundary.txt', 'cross-boundary violation\n')
    const firstCandidate = closeEvidence({
      repositoryPath: project,
      taskId: 'pilot-r2-review',
      contractContent,
      acceptanceId: 'R2-AC-01',
      checkId: 'check:r2-boundary',
      implementationCommit: violating.commit,
      implementationTree: violating.tree,
      runId: 'r2-run-1',
      evidenceKind: 'integration',
    })
    const candidate = runInput(['task', 'verify'], {
      risk: 'R2',
      authorizationRequired: false,
      authorizationApproved: false,
      verification: firstCandidate.verification,
    }, project)
    expect(candidate.status, candidate.stderr).toBe(0)

    const selfReview = runInput(['task', 'review'], {
      risk: 'R2',
      implementationOwner: 'codex-pilot',
      reviewOwner: 'codex-pilot',
      blockingFindingIds: [],
    }, project)
    expect(selfReview.status).not.toBe(0)
    expect(selfReview.json.errors).toContain('INDEPENDENT_REVIEW_REQUIRED')

    const repairReview = runInput(['task', 'review'], {
      risk: 'R2',
      implementationOwner: 'codex-pilot',
      reviewOwner: 'independent-reviewer',
      blockingFindingIds: ['R2-F-01'],
    }, project)
    expect(repairReview.status).not.toBe(0)
    expect(repairReview.json.errors).toContain('BLOCKING_FINDING:R2-F-01')

    const repaired = commitImplementation(project, 'boundary.txt', 'bounded repair\n')
    const repairedCandidate = closeEvidence({
      repositoryPath: project,
      taskId: 'pilot-r2-review',
      contractContent,
      acceptanceId: 'R2-AC-01',
      checkId: 'check:r2-boundary',
      implementationCommit: repaired.commit,
      implementationTree: repaired.tree,
      runId: 'r2-run-2',
      evidenceKind: 'integration',
    })
    const repairedVerification = runInput(['task', 'verify'], {
      risk: 'R2',
      authorizationRequired: false,
      authorizationApproved: false,
      verification: repairedCandidate.verification,
    }, project)
    expect(repairedVerification.status, repairedVerification.stderr).toBe(0)

    const acceptedReview = runInput(['task', 'review'], {
      risk: 'R2',
      implementationOwner: 'codex-pilot',
      reviewOwner: 'independent-reviewer',
      blockingFindingIds: [],
    }, project)
    expect(acceptedReview.status, acceptedReview.stderr).toBe(0)
    const close = runInput(['task', 'close'], {
      state: 'ACCEPTED',
      projectStatusValid: true,
      pendingRequiredIds: [],
    }, project)
    expect(close.status, close.stderr).toBe(0)
  })

  it('keeps R3 blocked without an exact active scoped authorization', () => {
    const start = startPilot('tests/pilots/r3-authorization/start.yaml')
    expect(start).toMatchObject({ risk: 'R3', state: 'DEFINED' })
    const contractContent = (start.artifacts as Array<{ content: string }>)[0]!.content
    const project = repository('sop-r3-pilot-')
    const implementation = commitImplementation(project, 'temporary-target.txt', 'temporary\n')
    const candidateState = closeEvidence({
      repositoryPath: project,
      taskId: 'pilot-r3-authorization',
      contractContent,
      acceptanceId: 'R3-AC-01',
      checkId: 'check:r3-temporary-target',
      implementationCommit: implementation.commit,
      implementationTree: implementation.tree,
      runId: 'r3-run-1',
      evidenceKind: 'integration',
    })
    const base = {
      risk: 'R3',
      authorizationRequired: true,
      verification: candidateState.verification,
      requestedAuthorizationScope: ['temporary-project:r3-pilot'],
      authorizationCheckTime: '2026-07-29T00:30:00Z',
    }

    const missing = runInput(['task', 'verify'], {
      ...base,
      authorizationApproved: false,
    }, project)
    expect(missing.status).not.toBe(0)
    expect(missing.json.errors).toContain('USER_AUTHORIZATION_REQUIRED')

    const booleanOnly = runInput(['task', 'verify'], {
      ...base,
      authorizationApproved: true,
    }, project)
    expect(booleanOnly.status).not.toBe(0)
    expect(booleanOnly.json.errors).toContain('AUTHORIZATION_RECORD_REQUIRED')

    const authorization = JSON.parse(readFileSync(
      'tests/pilots/r3-authorization/authorization.json',
      'utf8',
    )) as Record<string, unknown>
    const scoped = runInput(['task', 'verify'], {
      ...base,
      authorizationApproved: true,
      authorization,
    }, project)
    expect(scoped.status, scoped.stderr).toBe(0)

    const drifted = runInput(['task', 'verify'], {
      ...base,
      authorizationApproved: true,
      authorization,
      requestedAuthorizationScope: ['temporary-project:other'],
    }, project)
    expect(drifted.status).not.toBe(0)
    expect(drifted.json.errors).toContain('AUTHORIZATION_SCOPE_MISMATCH')

    const expired = runInput(['task', 'verify'], {
      ...base,
      authorizationApproved: true,
      authorization,
      authorizationCheckTime: '2026-07-29T01:00:00Z',
    }, project)
    expect(expired.status).not.toBe(0)
    expect(expired.json.errors).toContain('AUTHORIZATION_EXPIRED')
  })
}, 30_000)
