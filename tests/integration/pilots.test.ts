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

import { planAdoption } from '../../src/commands/adopt.js'
import { applyAdoption } from '../../src/commands/init.js'
import { testRunnerBundle } from '../helpers/runner-bundle.js'

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
  identities: Array<{ repository: string; commit: string; tree: string }>
  taskRoot: string
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
  const artifactPath = join(taskRoot, 'artifacts', `${options.runId}.json`)
  const execution = runInput(['task', 'execute'], {
    schemaVersion: 1,
    runId: options.runId,
    checkIds: [options.checkId],
    command: {
      executable: process.execPath,
      arguments: ['-e', `process.stdout.write(${JSON.stringify(`${options.checkId} passed\n`)})`],
      cwd: options.repositoryPath,
    },
    outputPath: artifactPath,
  }, options.repositoryPath)
  expect(execution.status, execution.stderr).toBe(0)
  const rawArtifact = readFileSync(artifactPath, 'utf8')
  const executionArtifact = JSON.parse(rawArtifact) as {
    command: { executable: string; arguments: string[]; cwd: string }
    startedAt: string
    endedAt: string
    exitCode: number
  }
  const evidencePath = join(taskRoot, `evidence-${options.runId}.json`)
  const identities = [{
    repository: options.repositoryPath,
    commit: options.implementationCommit,
    tree: options.implementationTree,
  }]
  write(evidencePath, `${JSON.stringify({
    schemaVersion: 1,
    taskId: options.taskId,
    contractDigest: contract.contractDigest,
    runId: options.runId,
    runnerVersion: '1.0.0',
    implementationCommits: [{
      repository: options.repositoryPath,
      commit: options.implementationCommit,
      tree: options.implementationTree,
    }],
    records: [{
      acceptanceId: options.acceptanceId,
      runId: options.runId,
      executedCheckIds: [options.checkId],
      command: executionArtifact.command,
      exitCode: executionArtifact.exitCode,
      startedAt: executionArtifact.startedAt,
      endedAt: executionArtifact.endedAt,
      evidenceKind: options.evidenceKind,
      implementationIdentities: identities,
      rawArtifact: {
        path: `.delivery/tasks/${options.taskId}/artifacts/${options.runId}.json`,
        sha256: sha256(rawArtifact),
        format: 'sop-command-execution-v1',
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
    identities,
    taskRoot,
    verification: {
      contractPath,
      evidencePath,
      artifactRoot: options.repositoryPath,
      requiredEvidenceKinds: { [options.acceptanceId]: options.evidenceKind },
      expectedImplementationIdentities: identities,
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

function writeCandidate(
  state: CandidateState,
  risk: 'R2' | 'R3',
  authorization: Record<string, unknown> = {
    authorizationRequired: false,
    authorizationApproved: false,
  },
): string {
  const path = join(state.taskRoot, `candidate-${state.closureCommit.slice(0, 12)}.json`)
  write(path, `${JSON.stringify({
    risk,
    ...authorization,
    verification: state.verification,
  }, null, 2)}\n`)
  return path
}

function writeReview(options: {
  state: CandidateState
  candidatePath: string
  reviewer: string
  decision: 'ACCEPTED' | 'REPAIR_REQUIRED'
  findings: Array<{ id: string; severity: 'P1'; classification: 'contract_violation'; observation: string }>
}): string {
  const contract = parse(readFileSync(
    options.state.verification.contractPath as string,
    'utf8',
  )) as { taskId: string; contractDigest: string }
  const path = join(
    options.state.taskRoot,
    `review-${options.state.closureCommit.slice(0, 12)}-${options.reviewer}.json`,
  )
  write(path, `${JSON.stringify({
    schemaVersion: 1,
    taskId: contract.taskId,
    contractDigest: contract.contractDigest,
    candidateDigest: sha256(readFileSync(options.candidatePath, 'utf8')),
    reviewedImplementation: options.state.identities,
    reviewer: options.reviewer,
    decision: options.decision,
    findings: options.findings,
    nextStage: options.decision === 'ACCEPTED' ? 'ACCEPTED' : 'REPAIR_REQUIRED',
    userActionRequired: false,
  }, null, 2)}\n`)
  return path
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
    const firstCandidatePath = writeCandidate(firstCandidate, 'R2')
    const candidate = runCli(['task', 'verify', '--input', firstCandidatePath])
    expect(candidate.status, candidate.stderr).toBe(0)

    const selfReviewPath = writeReview({
      state: firstCandidate,
      candidatePath: firstCandidatePath,
      reviewer: 'codex-pilot',
      decision: 'ACCEPTED',
      findings: [],
    })
    const selfReview = runInput(['task', 'review'], {
      candidatePath: firstCandidatePath,
      reviewPath: selfReviewPath,
    }, project)
    expect(selfReview.status).not.toBe(0)
    expect(selfReview.json.errors).toContain('INDEPENDENT_REVIEW_REQUIRED')

    const repairReviewPath = writeReview({
      state: firstCandidate,
      candidatePath: firstCandidatePath,
      reviewer: 'independent-reviewer',
      decision: 'REPAIR_REQUIRED',
      findings: [{
        id: 'R2-F-01',
        severity: 'P1',
        classification: 'contract_violation',
        observation: 'The boundary remains violated.',
      }],
    })
    const repairReview = runInput(['task', 'review'], {
      candidatePath: firstCandidatePath,
      reviewPath: repairReviewPath,
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
    const repairedCandidatePath = writeCandidate(repairedCandidate, 'R2')
    const repairedVerification = runCli(['task', 'verify', '--input', repairedCandidatePath])
    expect(repairedVerification.status, repairedVerification.stderr).toBe(0)

    const acceptedReviewPath = writeReview({
      state: repairedCandidate,
      candidatePath: repairedCandidatePath,
      reviewer: 'independent-reviewer',
      decision: 'ACCEPTED',
      findings: [],
    })
    const acceptedReview = runInput(['task', 'review'], {
      candidatePath: repairedCandidatePath,
      reviewPath: acceptedReviewPath,
    }, project)
    expect(acceptedReview.status, acceptedReview.stderr).toBe(0)
    const candidateBytes = readFileSync(repairedCandidatePath, 'utf8')
    write(repairedCandidatePath, `${candidateBytes}\n`)
    const driftedCandidateReview = runInput(['task', 'review'], {
      candidatePath: repairedCandidatePath,
      reviewPath: acceptedReviewPath,
    }, project)
    expect(driftedCandidateReview.status).not.toBe(0)
    expect(driftedCandidateReview.json.errors).toContain('REVIEW_CANDIDATE_DIGEST_MISMATCH')
    write(repairedCandidatePath, candidateBytes)

    const acceptedReviewDocument = JSON.parse(readFileSync(acceptedReviewPath, 'utf8')) as {
      reviewedImplementation: Array<{ tree: string }>
    }
    const reviewedTree = acceptedReviewDocument.reviewedImplementation[0]!.tree
    acceptedReviewDocument.reviewedImplementation[0]!.tree = 'f'.repeat(40)
    write(acceptedReviewPath, `${JSON.stringify(acceptedReviewDocument, null, 2)}\n`)
    const driftedIdentityReview = runInput(['task', 'review'], {
      candidatePath: repairedCandidatePath,
      reviewPath: acceptedReviewPath,
    }, project)
    expect(driftedIdentityReview.status).not.toBe(0)
    expect(driftedIdentityReview.json.errors).toContain(
      'REVIEW_IMPLEMENTATION_IDENTITY_MISMATCH',
    )
    acceptedReviewDocument.reviewedImplementation[0]!.tree = reviewedTree
    write(acceptedReviewPath, `${JSON.stringify(acceptedReviewDocument, null, 2)}\n`)
    const adoption = planAdoption(project, { runnerBundlePath: testRunnerBundle() })
    applyAdoption(adoption, adoption.digest)
    const nextAction = 'Close the accepted pilot.'
    const statusPath = join(repairedCandidate.taskRoot, 'handoff.md')
    write(statusPath, `# pilot-r2-review\n\nAccepted. Next action: ${nextAction}\n`)
    const contract = parse(readFileSync(
      repairedCandidate.verification.contractPath as string,
      'utf8',
    )) as { taskId: string; contractDigest: string }
    const closurePath = join(repairedCandidate.taskRoot, 'closure.json')
    write(closurePath, `${JSON.stringify({
      schemaVersion: 1,
      taskId: contract.taskId,
      contractDigest: contract.contractDigest,
      state: 'ACCEPTED',
      candidate: {
        path: repairedCandidatePath,
        sha256: sha256(readFileSync(repairedCandidatePath, 'utf8')),
      },
      review: {
        path: acceptedReviewPath,
        sha256: sha256(readFileSync(acceptedReviewPath, 'utf8')),
      },
      projectPath: project,
      statusArtifacts: [{
        path: statusPath,
        sha256: sha256(readFileSync(statusPath, 'utf8')),
      }],
      nextAction,
      userActionRequired: false,
    }, null, 2)}\n`)
    const close = runInput(['task', 'close'], {
      closurePath,
    }, project)
    expect(close.status, close.stderr).toBe(0)

    write(statusPath, '# pilot-r2-review\n\nAccepted, but next action is omitted.\n')
    const incoherentClosure = JSON.parse(readFileSync(closurePath, 'utf8')) as {
      statusArtifacts: Array<{ sha256: string }>
    }
    incoherentClosure.statusArtifacts[0]!.sha256 = sha256(readFileSync(statusPath, 'utf8'))
    write(closurePath, `${JSON.stringify(incoherentClosure, null, 2)}\n`)
    const incoherentClose = runInput(['task', 'close'], { closurePath }, project)
    expect(incoherentClose.status).not.toBe(0)
    expect(incoherentClose.json.errors).toContain('STATUS_ARTIFACT_NEXT_ACTION_MISSING')
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
    const authorizationNow = Date.now()
    authorization.issuedAt = new Date(authorizationNow - 60_000).toISOString()
    authorization.expiresAt = new Date(authorizationNow + 60_000).toISOString()
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

    const callerControlledClock = runInput(['task', 'verify'], {
      ...base,
      authorizationApproved: true,
      authorization,
      authorizationCheckTime: '2026-07-29T01:00:00Z',
    }, project)
    expect(callerControlledClock.status).not.toBe(0)
    expect(callerControlledClock.json.errors).toContain(
      'AUTHORIZATION_CHECK_TIME_CALLER_CONTROLLED',
    )

    const expired = runInput(['task', 'verify'], {
      ...base,
      authorizationApproved: true,
      authorization: {
        ...authorization,
        issuedAt: new Date(authorizationNow - 120_000).toISOString(),
        expiresAt: new Date(authorizationNow - 60_000).toISOString(),
      },
    }, project)
    expect(expired.status).not.toBe(0)
    expect(expired.json.errors).toContain('AUTHORIZATION_EXPIRED')
  })
}, 30_000)
