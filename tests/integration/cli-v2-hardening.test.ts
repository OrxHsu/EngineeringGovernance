import { execFileSync, spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import { parse, stringify } from 'yaml'

import { planAdoption } from '../../src/commands/adopt.js'
import { applyAdoption } from '../../src/commands/init.js'
import { startTask } from '../../src/commands/task-start.js'
import { captureCommandExecution } from '../../src/evidence/capture.js'
import { buildProgram } from '../../src/cli/main.js'
import { extensionDescriptor } from '../../src/extensions/registry.js'
import { canonicalDigest } from '../../src/model/digest.js'
import { applyTaskTransition, planTaskTransition } from '../../src/state/ledger.js'
import {
  hardenedTaskFixture,
  sha256,
  writeAcceptedContractReadinessReview,
} from '../helpers/hardened-task.js'
import { testRunnerBundle } from '../helpers/runner-bundle.js'

const temporaryDirectories: string[] = []

function adoptedProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'sop-cli-v2-'))
  temporaryDirectories.push(root)
  execFileSync('git', ['-C', root, 'init', '-b', 'main'])
  execFileSync('git', ['-C', root, 'config', 'user.email', 'test@example.com'])
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Test'])
  writeFileSync(join(root, 'AGENTS.md'), '# Project rules\n')
  writeFileSync(join(root, 'baseline.txt'), 'baseline\n')
  execFileSync('git', ['-C', root, 'add', 'AGENTS.md', 'baseline.txt'])
  execFileSync('git', ['-C', root, 'commit', '-m', 'baseline'])
  const adoption = planAdoption(root, { runnerBundlePath: testRunnerBundle() })
  applyAdoption(adoption, adoption.digest)
  return root
}

function definedV2Task(
  expectedExitCode: number,
  script: string,
  replay: 'required' | 'not-required' = 'not-required',
): { root: string; inputPath: string; taskId: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'sop-cli-execute-v2-')))
  temporaryDirectories.push(root)
  execFileSync('git', ['-C', root, 'init', '-b', 'main'])
  execFileSync('git', ['-C', root, 'config', 'user.email', 'test@example.com'])
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Test'])
  writeFileSync(join(root, 'baseline.txt'), 'baseline\n')
  execFileSync('git', ['-C', root, 'add', 'baseline.txt'])
  execFileSync('git', ['-C', root, 'commit', '-m', 'baseline'])
  const taskId = `execute-${expectedExitCode}`
  const task = startTask({
    schemaVersion: 2,
    taskId,
    implementationOwner: 'codex',
    objective: 'Exercise v2 CLI execution status.',
    scope: ['baseline.txt'],
    nonGoals: [],
    authorityInputs: ['spec.md'],
    repositories: [{ id: 'root', path: root }],
    acceptance: [{
      id: 'AC-01',
      observation: 'The exact exit policy is observed.',
      positiveCases: ['expected exit'],
      negativeCases: ['unexpected exit'],
      evidenceKind: 'unit',
      command: {
        repositoryId: 'root',
        cwd: '.',
        executable: process.execPath,
        arguments: ['-e', script],
      },
      observerPolicy: {
        expectedExitCode,
        output: 'exit-only',
        checkoutMutation: 'forbidden',
        replay,
      },
    }],
    authorizationRequirements: [],
    openChoices: [],
    signals: { mutation: true, crossModule: true },
  })
  for (const artifact of task.artifacts) {
    const path = join(root, artifact.path)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, artifact.content)
  }
  const contractPath = join(root, `.delivery/tasks/${taskId}/contract.yaml`)
  const contractRaw = readFileSync(contractPath)
  writeAcceptedContractReadinessReview({
    root,
    taskId,
    contractPath,
    contractRaw,
    contract: parse(contractRaw.toString('utf8')) as Record<string, unknown>,
  })
  const inputPath = join(root, 'execute.yaml')
  writeFileSync(inputPath, stringify({
    schemaVersion: 2,
    projectRoot: root,
    taskId,
    acceptanceId: 'AC-01',
    runId: 'run-1',
  }))
  return { root, inputPath, taskId }
}

function replayCandidateFixture(): { root: string; candidatePath: string; verificationPath: string } {
  const fixture = definedV2Task(0, "process.stdout.write('replayed\\n')", 'required')
  const contractPath = join(fixture.root, `.delivery/tasks/${fixture.taskId}/contract.yaml`)
  const evidencePath = join(fixture.root, `.delivery/tasks/${fixture.taskId}/evidence.json`)
  writeFileSync(evidencePath, '{}\n')
  const commit = execFileSync('git', ['-C', fixture.root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  const tree = execFileSync('git', ['-C', fixture.root, 'rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).trim()
  const candidatePath = join(fixture.root, `.delivery/tasks/${fixture.taskId}/candidate.yaml`)
  writeFileSync(candidatePath, stringify({
    schemaVersion: 2,
    taskId: fixture.taskId,
    contract: { path: contractPath, sha256: sha256(readFileSync(contractPath)) },
    evidence: { path: evidencePath, sha256: sha256(readFileSync(evidencePath)) },
    implementationIdentities: [{
      repositoryId: 'root',
      repository: fixture.root,
      commit,
      tree,
      checkoutDigest: 'a'.repeat(64),
    }],
    gitIdentities: [{
      repositoryId: 'root',
      repository: fixture.root,
      implementationCommit: commit,
      implementationTree: tree,
      closureCommit: commit,
      allowedClosurePaths: ['.delivery/tasks/**'],
    }],
    authorizationArtifacts: [],
    extensionArtifacts: [],
  }))
  const inProgress = planTaskTransition({
    projectRoot: fixture.root,
    taskId: fixture.taskId,
    actorId: 'codex',
    to: 'IN_PROGRESS',
    artifacts: [{ kind: 'contract-review', path: join(fixture.root, `.delivery/tasks/${fixture.taskId}/contract-review.yaml`) }],
  })
  if (!applyTaskTransition(inProgress, inProgress.digest).applied) {
    throw new Error('replay fixture IN_PROGRESS transition failed')
  }
  const candidate = planTaskTransition({
    projectRoot: fixture.root,
    taskId: fixture.taskId,
    actorId: 'codex',
    to: 'CANDIDATE',
    artifacts: [
      { kind: 'candidate', path: candidatePath },
      { kind: 'evidence', path: evidencePath },
    ],
  })
  if (!applyTaskTransition(candidate, candidate.digest).applied) {
    throw new Error('replay fixture CANDIDATE transition failed')
  }
  return {
    root: fixture.root,
    candidatePath,
    verificationPath: join(fixture.root, `.delivery/tasks/${fixture.taskId}/replay-verification.json`),
  }
}

afterEach(() => {
  process.exitCode = undefined
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('v2 CLI hardening', () => {
  it('rejects omitted and partial v2 start and execute inputs with stable errors', () => {
    for (const input of [
      { schemaVersion: 2 },
      { schemaVersion: 2, signals: { mutation: true } },
      { schemaVersion: 2, signals: {} },
    ]) {
      expect(() => startTask(input as never)).toThrow('TASK_START_INPUT_INVALID')
    }

    for (const input of [
      { schemaVersion: 2 },
      { schemaVersion: 2, projectRoot: '/tmp', taskId: 'task', acceptanceId: 'AC-01' },
    ]) {
      expect(() => captureCommandExecution(input as never)).toThrow('COMMAND_EXECUTION_INPUT_INVALID')
    }
  })

  it('starts a v2 task from an explicit adopted project and freezes its extensions', async () => {
    const project = adoptedProject()
    const descriptor = extensionDescriptor('external-source-provenance', '1.0.0')
    writeFileSync(join(project, '.delivery/extensions.yaml'), stringify({
      schemaVersion: 2,
      extensions: [{ id: descriptor.id, version: descriptor.version, digest: descriptor.digest }],
    }))
    const inputPath = join(project, 'task-start.yaml')
    writeFileSync(inputPath, stringify({
      schemaVersion: 2,
      taskId: 'cli-v2-start',
      implementationOwner: 'codex',
      objective: 'Exercise the v2 CLI start path.',
      scope: ['baseline.txt'],
      nonGoals: [],
      authorityInputs: ['spec.md'],
      repositories: [{ id: 'root', path: project }],
      acceptance: [{
        id: 'AC-01',
        observation: 'The pinned command reports a version.',
        positiveCases: ['command succeeds'],
        negativeCases: ['command fails'],
        evidenceKind: 'static',
        command: {
          repositoryId: 'root',
          cwd: '.',
          executable: process.execPath,
          arguments: ['--version'],
        },
        observerPolicy: {
          expectedExitCode: 0,
          output: 'nonempty',
          checkoutMutation: 'forbidden',
          replay: 'not-required',
        },
      }],
      authorizationRequirements: [],
      extensionInputs: {
        'external-source-provenance@1.0.0': { mode: 'independent' },
      },
      openChoices: [],
      signals: { mutation: true, crossModule: true },
    }))

    let output = ''
    await buildProgram({ write: (text) => { output += text } }).parseAsync([
      'node',
      'sop',
      'task',
      'start',
      '--project',
      project,
      '--input',
      inputPath,
    ])

    const result = JSON.parse(output) as {
      digest: string
      artifacts: Array<{ path: string; content: string }>
    }
    const contract = parse(result.artifacts[0]!.content) as { extensions: unknown[] }
    expect(contract.extensions).toEqual([{
      id: descriptor.id,
      version: descriptor.version,
      digest: descriptor.digest,
      input: { mode: 'independent' },
    }])
    const taskDirectory = join(realpathSync(project), '.delivery/tasks/cli-v2-start')
    expect(existsSync(taskDirectory)).toBe(false)

    const originalInput = readFileSync(inputPath, 'utf8')
    writeFileSync(inputPath, originalInput.replace(
      'Exercise the v2 CLI start path.',
      'Drifted objective.',
    ))
    await expect(buildProgram().parseAsync([
      'node', 'sop', 'task', 'start', '--project', project, '--input', inputPath,
      '--apply-plan', result.digest,
    ])).rejects.toThrow('TASK_START_PLAN_DIGEST_MISMATCH')
    expect(existsSync(taskDirectory)).toBe(false)
    writeFileSync(inputPath, originalInput)

    await expect(buildProgram().parseAsync([
      'node', 'sop', 'task', 'start', '--project', project, '--input', inputPath,
      '--apply-plan', '0'.repeat(64),
    ])).rejects.toThrow('TASK_START_PLAN_DIGEST_MISMATCH')
    expect(existsSync(taskDirectory)).toBe(false)

    output = ''
    await buildProgram({ write: (text) => { output += text } }).parseAsync([
      'node', 'sop', 'task', 'start', '--project', project, '--input', inputPath,
      '--apply-plan', result.digest,
    ])
    expect((JSON.parse(output) as { applied: string[] }).applied).toEqual([
      join(taskDirectory, 'contract.yaml'),
      join(taskDirectory, 'ledger.jsonl'),
    ])

    const contractPath = join(taskDirectory, 'contract.yaml')
    const contractRaw = readFileSync(contractPath)
    const reviewPath = writeAcceptedContractReadinessReview({
      root: project,
      taskId: 'cli-v2-start',
      contractPath,
      contractRaw,
      contract: parse(contractRaw.toString('utf8')) as Record<string, unknown>,
    })

    const transitionInput = join(project, 'task-transition.yaml')
    writeFileSync(transitionInput, stringify({
      schemaVersion: 2,
      projectRoot: project,
      taskId: 'cli-v2-start',
      actorId: 'codex',
      to: 'IN_PROGRESS',
      artifacts: [{ kind: 'contract-review', path: reviewPath }],
    }))
    output = ''
    await buildProgram({ write: (text) => { output += text } }).parseAsync([
      'node', 'sop', 'task', 'transition', '--input', transitionInput,
    ])
    const transitionPlan = JSON.parse(output) as { digest: string }
    output = ''
    await buildProgram({ write: (text) => { output += text } }).parseAsync([
      'node', 'sop', 'task', 'transition', '--input', transitionInput,
      '--apply-plan', transitionPlan.digest,
    ])
    expect(JSON.parse(output)).toEqual({ applied: true, errors: [] })
    const ledgerEvents = readFileSync(join(taskDirectory, 'ledger.jsonl'), 'utf8')
      .trim().split('\n').map((line) => JSON.parse(line) as { to: string })
    expect(ledgerEvents.at(-1)?.to).toBe('IN_PROGRESS')
  }, 30_000)

  it('rejects legacy task start input on the active command', async () => {
    const project = adoptedProject()
    const inputPath = join(project, 'legacy-start.yaml')
    writeFileSync(inputPath, stringify({
      schemaVersion: 1,
      taskId: 'legacy-start',
      implementationOwner: 'codex',
      objective: 'Do not run this legacy request.',
      scope: ['baseline.txt'],
      nonGoals: [],
      authorityInputs: ['spec.md'],
      acceptance: [{
        id: 'AC-01',
        observation: 'Legacy input remains inspect-only.',
        positiveCases: ['inspect'],
        negativeCases: ['active start'],
      }],
      requiredGates: ['node --version'],
      openChoices: [],
      signals: { mutation: true, classificationComplete: true },
    }))

    await expect(buildProgram().parseAsync([
      'node', 'sop', 'task', 'start', '--project', project, '--input', inputPath,
    ])).rejects.toThrow('ACTIVE_COMMAND_REQUIRES_SCHEMA_VERSION_2')
  })

  it('verifies the canonical candidate input and persists verification only when requested', async () => {
    const fixture = hardenedTaskFixture()
    temporaryDirectories.push(fixture.root)
    rmSync(fixture.verificationPath)
    let output = ''

    await buildProgram({ write: (text) => { output += text } }).parseAsync([
      'node', 'sop', 'task', 'verify', '--input', fixture.candidatePath,
    ])
    expect(JSON.parse(output)).toMatchObject({ valid: true, errors: [] })
    expect(existsSync(fixture.verificationPath)).toBe(false)
    output = ''

    await buildProgram({ write: (text) => { output += text } }).parseAsync([
      'node', 'sop', 'task', 'verify', '--input', fixture.candidatePath, '--persist',
    ])

    const result = JSON.parse(output) as {
      valid: boolean
      persistedVerification: { path: string; sha256: string }
      verificationArtifact: unknown
    }
    expect(result.valid).toBe(true)
    expect(result.persistedVerification.path).toBe(fixture.verificationPath)
    expect(existsSync(fixture.verificationPath)).toBe(true)
    expect(JSON.parse(readFileSync(fixture.verificationPath, 'utf8'))).toEqual(result.verificationArtifact)
  })

  it('rejects a candidate symlink before verification persistence', async () => {
    const fixture = hardenedTaskFixture()
    temporaryDirectories.push(fixture.root)
    rmSync(fixture.verificationPath)
    const symlink = join(fixture.root, 'candidate-link.yaml')
    symlinkSync(fixture.candidatePath, symlink)

    await expect(buildProgram().parseAsync([
      'node', 'sop', 'task', 'verify', '--input', symlink, '--persist',
    ])).rejects.toThrow('CLI_INPUT_PATH_UNSAFE')
    expect(existsSync(fixture.verificationPath)).toBe(false)
  })

  it('executes a candidate replay only with the exact current plan digest', async () => {
    const fixture = replayCandidateFixture()
    let output = ''

    await buildProgram({ write: (text) => { output += text } }).parseAsync([
      'node', 'sop', 'task', 'replay', '--input', fixture.candidatePath,
    ])
    const plan = JSON.parse(output) as { artifactType: string; digest: string }
    expect(plan.artifactType).toBe('sop-replay-plan-v2')
    expect(plan.digest).toMatch(/^[a-f0-9]{64}$/)
    expect(existsSync(fixture.verificationPath)).toBe(false)

    await expect(buildProgram().parseAsync([
      'node', 'sop', 'task', 'replay', '--input', fixture.candidatePath,
      '--apply-plan', '0'.repeat(64),
    ])).rejects.toThrow('REPLAY_PLAN_DIGEST_MISMATCH')
    expect(existsSync(fixture.verificationPath)).toBe(false)

    output = ''
    await buildProgram({ write: (text) => { output += text } }).parseAsync([
      'node', 'sop', 'task', 'replay', '--input', fixture.candidatePath,
      '--apply-plan', plan.digest,
    ])
    expect(JSON.parse(output)).toMatchObject({
      path: fixture.verificationPath,
      artifact: { decision: 'eligible', planDigest: plan.digest },
    })
    expect(existsSync(fixture.verificationPath)).toBe(true)
  })

  it('uses v2 policy errors rather than the raw expected command exit as process status', async () => {
    const fixture = definedV2Task(7, 'process.exit(7)')
    let output = ''

    await buildProgram({ write: (text) => { output += text } }).parseAsync([
      'node', 'sop', 'task', 'execute', '--input', fixture.inputPath,
    ])

    const receipt = JSON.parse(output) as { exitCode: number; policyErrors: string[] }
    expect(receipt).toMatchObject({ exitCode: 7, policyErrors: [] })
    expect(process.exitCode).toBeUndefined()

    process.exitCode = undefined
    const violatingFixture = definedV2Task(7, 'process.exit(0)')
    output = ''
    await buildProgram({ write: (text) => { output += text } }).parseAsync([
      'node', 'sop', 'task', 'execute', '--input', violatingFixture.inputPath,
    ])
    const violatingReceipt = JSON.parse(output) as { exitCode: number; policyErrors: string[] }
    expect(violatingReceipt.exitCode).toBe(0)
    expect(violatingReceipt.policyErrors).toContain('UNEXPECTED_EXIT_CODE:7:0')
    expect(process.exitCode).toBe(1)
  })

  it('returns shell status from v2 policy errors', () => {
    const executable = join(process.cwd(), 'node_modules', '.bin', 'tsx')
    const passing = definedV2Task(7, 'process.exit(7)')
    const passingResult = spawnSync(executable, [
      'src/cli/main.ts', 'task', 'execute', '--input', passing.inputPath,
    ], { cwd: process.cwd(), encoding: 'utf8' })
    expect(passingResult.status, passingResult.stderr).toBe(0)
    expect(JSON.parse(passingResult.stdout)).toMatchObject({ exitCode: 7, policyErrors: [] })

    const failing = definedV2Task(7, 'process.exit(0)')
    const failingResult = spawnSync(executable, [
      'src/cli/main.ts', 'task', 'execute', '--input', failing.inputPath,
    ], { cwd: process.cwd(), encoding: 'utf8' })
    expect(failingResult.status, failingResult.stderr).toBe(1)
    expect(JSON.parse(failingResult.stdout)).toMatchObject({
      exitCode: 0,
      policyErrors: ['UNEXPECTED_EXIT_CODE:7:0'],
    })
  })

  it('keeps versionless legacy candidates on the read-only inspect command', async () => {
    const project = mkdtempSync(join(tmpdir(), 'sop-cli-legacy-'))
    temporaryDirectories.push(project)
    const inputPath = join(project, 'candidate.yaml')
    writeFileSync(inputPath, stringify({
      risk: 'R2',
      requiredGateErrors: [],
      authorizationRequired: false,
      authorizationApproved: false,
      verification: {
        contractPath: join(project, 'missing-contract.yaml'),
        evidencePath: join(project, 'missing-evidence.json'),
        artifactRoot: project,
        requiredEvidenceKinds: { 'AC-01': 'unit' },
        expectedImplementationIdentities: [{
          repository: project,
          commit: 'a'.repeat(40),
          tree: 'b'.repeat(40),
        }],
        maxEvidenceAgeMs: 60_000,
        gitIdentities: [{
          repository: project,
          implementationCommit: 'a'.repeat(40),
          implementationTree: 'b'.repeat(40),
          closureCommit: 'c'.repeat(40),
          allowedClosurePaths: ['.delivery/tasks/**'],
        }],
      },
    }))
    let output = ''

    await buildProgram({ write: (text) => { output += text } }).parseAsync([
      'node', 'sop', 'legacy', 'inspect', '--input', inputPath,
    ])

    expect(JSON.parse(output)).toEqual({
      valid: true,
      errors: [],
      kind: 'candidate',
      schemaVersion: null,
      summary: { risk: 'R2' },
    })
    await expect(buildProgram().parseAsync([
      'node', 'sop', 'task', 'verify', '--input', inputPath,
    ])).rejects.toThrow('ACTIVE_COMMAND_REQUIRES_SCHEMA_VERSION_2')
  })

  it('inspects versionless legacy task-start inputs without activating them', async () => {
    const pilotInputs = [
      ['tests/pilots/r1-local/start.yaml', 'pilot-r1-local'],
      ['tests/pilots/r2-review/start.yaml', 'pilot-r2-review'],
      ['tests/pilots/r3-authorization/start.yaml', 'pilot-r3-authorization'],
    ] as const
    for (const [inputPath, taskId] of pilotInputs) {
      let output = ''
      await buildProgram({ write: (text) => { output += text } }).parseAsync([
        'node', 'sop', 'legacy', 'inspect', '--input', inputPath,
      ])
      expect(JSON.parse(output)).toMatchObject({
        valid: true,
        errors: [],
        kind: 'task-start',
        schemaVersion: null,
        summary: { taskId, implementationOwner: 'codex-pilot' },
      })
    }

    const project = adoptedProject()
    await expect(buildProgram().parseAsync([
      'node', 'sop', 'task', 'start', '--project', project,
      '--input', pilotInputs[0][0],
    ])).rejects.toThrow('ACTIVE_COMMAND_REQUIRES_SCHEMA_VERSION_2')
  })

  it('rejects legacy execute, review, and close inputs before side effects', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sop-cli-legacy-active-'))
    temporaryDirectories.push(root)
    const marker = join(root, 'legacy-executed')
    const executePath = join(root, 'execute.yaml')
    writeFileSync(executePath, stringify({
      schemaVersion: 1,
      runId: 'legacy-run',
      command: { executable: '/usr/bin/touch', arguments: [marker], cwd: root },
      outputPath: join(root, 'legacy-receipt.json'),
    }))
    const reviewPath = join(root, 'review-input.yaml')
    writeFileSync(reviewPath, stringify({
      candidatePath: join(root, 'candidate.yaml'),
      reviewPath: join(root, 'review.yaml'),
      replayPlanDigest: 'a'.repeat(64),
    }))
    const closePath = join(root, 'closure.yaml')
    writeFileSync(closePath, stringify({
      schemaVersion: 1,
      taskId: 'legacy-close',
      contractDigest: 'a'.repeat(64),
      state: 'ACCEPTED',
      replayPlanDigest: 'b'.repeat(64),
      candidate: { path: 'candidate.yaml', sha256: 'c'.repeat(64) },
      review: { path: 'review.yaml', sha256: 'd'.repeat(64) },
      projectPath: root,
      statusArtifacts: [{ path: 'STATUS.md', sha256: 'e'.repeat(64) }],
      nextAction: 'none',
      userActionRequired: false,
    }))

    for (const [command, path, additionalArguments] of [
      ['execute', executePath, []],
      ['review', reviewPath, ['--apply-plan', '0'.repeat(64)]],
      ['close', closePath, ['--apply-plan', '0'.repeat(64)]],
    ] as const) {
      await expect(buildProgram().parseAsync([
        'node', 'sop', 'task', command, '--input', path, ...additionalArguments,
      ])).rejects.toThrow('ACTIVE_COMMAND_REQUIRES_SCHEMA_VERSION_2')
    }
    expect(existsSync(marker)).toBe(false)
  })

  it('keeps unadopt dry-run until the exact current plan digest is applied', async () => {
    const project = adoptedProject()
    let output = ''

    await buildProgram({ write: (text) => { output += text } }).parseAsync([
      'node', 'sop', 'unadopt', project,
    ])
    const plan = JSON.parse(output) as { digest: string; removals: Array<{ path: string }> }
    expect(plan.digest).toMatch(/^[a-f0-9]{64}$/)
    expect(plan.removals.length).toBeGreaterThan(0)
    expect(existsSync(join(project, '.delivery/policy.yaml'))).toBe(true)

    await expect(buildProgram().parseAsync([
      'node', 'sop', 'unadopt', project, '--apply-plan', '0'.repeat(64),
    ])).rejects.toThrow('UNADOPTION_PLAN_DIGEST_MISMATCH')
    expect(existsSync(join(project, '.delivery/policy.yaml'))).toBe(true)

    output = ''
    await buildProgram({ write: (text) => { output += text } }).parseAsync([
      'node', 'sop', 'unadopt', project, '--apply-plan', plan.digest,
    ])
    expect((JSON.parse(output) as { applied: string[] }).applied.length).toBeGreaterThan(0)
    expect(existsSync(join(project, '.delivery/policy.yaml'))).toBe(false)
  })

  it('applies a v2 review transition only with the exact dry-run plan digest', async () => {
    const fixture = hardenedTaskFixture()
    temporaryDirectories.push(fixture.root)
    const reviewPath = join(fixture.root, `.delivery/tasks/${fixture.taskId}/review.yaml`)
    writeFileSync(reviewPath, stringify({
      schemaVersion: 2,
      artifactType: 'sop-review-v2',
      taskId: fixture.taskId,
      reviewer: { id: 'independent-reviewer', trustLevel: 'local-claim' },
      decision: 'ACCEPTED',
      contract: {
        path: fixture.contractPath,
        sha256: sha256(readFileSync(fixture.contractPath)),
        digest: fixture.contract.contractDigest,
      },
      candidate: {
        path: fixture.candidatePath,
        sha256: sha256(readFileSync(fixture.candidatePath)),
        digest: canonicalDigest(fixture.candidate),
      },
      verification: {
        path: fixture.verificationPath,
        sha256: sha256(readFileSync(fixture.verificationPath)),
      },
      reviewedImplementation: fixture.verification.implementationIdentities,
      findings: [],
      nextStage: 'close',
      userActionRequired: false,
    }))
    const ledgerPath = join(fixture.root, `.delivery/tasks/${fixture.taskId}/ledger.jsonl`)
    const ledgerBefore = readFileSync(ledgerPath, 'utf8')
    let output = ''

    await buildProgram({ write: (text) => { output += text } }).parseAsync([
      'node', 'sop', 'task', 'review', '--input', reviewPath,
    ])
    const dryRun = JSON.parse(output) as {
      valid: boolean
      transitionPlan: { digest: string }
    }
    expect(dryRun.valid).toBe(true)
    expect(dryRun.transitionPlan.digest).toMatch(/^[a-f0-9]{64}$/)
    expect(readFileSync(ledgerPath, 'utf8')).toBe(ledgerBefore)

    process.exitCode = undefined
    output = ''
    await buildProgram({ write: (text) => { output += text } }).parseAsync([
      'node', 'sop', 'task', 'review', '--input', reviewPath, '--apply-plan', '0'.repeat(64),
    ])
    expect(JSON.parse(output)).toMatchObject({
      valid: false,
      applied: false,
      errors: ['TASK_TRANSITION_PLAN_DIGEST_MISMATCH'],
    })
    expect(process.exitCode).toBe(1)
    expect(readFileSync(ledgerPath, 'utf8')).toBe(ledgerBefore)

    process.exitCode = undefined
    output = ''
    await buildProgram({ write: (text) => { output += text } }).parseAsync([
      'node', 'sop', 'task', 'review', '--input', reviewPath,
      '--apply-plan', dryRun.transitionPlan.digest,
    ])
    expect(JSON.parse(output)).toMatchObject({ valid: true, applied: true, errors: [] })
    expect(readFileSync(ledgerPath, 'utf8').split('\n').filter(Boolean)).toHaveLength(
      ledgerBefore.split('\n').filter(Boolean).length + 1,
    )
  })

  it('applies a v2 close transition only with the exact dry-run plan digest', async () => {
    const fixture = hardenedTaskFixture()
    temporaryDirectories.push(fixture.root)
    const taskDirectory = join(fixture.root, `.delivery/tasks/${fixture.taskId}`)
    const reviewPath = join(taskDirectory, 'review.yaml')
    writeFileSync(reviewPath, stringify({
      schemaVersion: 2,
      artifactType: 'sop-review-v2',
      taskId: fixture.taskId,
      reviewer: { id: 'independent-reviewer', trustLevel: 'local-claim' },
      decision: 'ACCEPTED',
      contract: {
        path: fixture.contractPath,
        sha256: sha256(readFileSync(fixture.contractPath)),
        digest: fixture.contract.contractDigest,
      },
      candidate: {
        path: fixture.candidatePath,
        sha256: sha256(readFileSync(fixture.candidatePath)),
        digest: canonicalDigest(fixture.candidate),
      },
      verification: {
        path: fixture.verificationPath,
        sha256: sha256(readFileSync(fixture.verificationPath)),
      },
      reviewedImplementation: fixture.verification.implementationIdentities,
      findings: [],
      nextStage: 'close',
      userActionRequired: false,
    }))
    let output = ''
    await buildProgram({ write: (text) => { output += text } }).parseAsync([
      'node', 'sop', 'task', 'review', '--input', reviewPath,
    ])
    const reviewPlan = (JSON.parse(output) as {
      transitionPlan: { digest: string; event: { eventDigest: string } }
    }).transitionPlan
    output = ''
    await buildProgram({ write: (text) => { output += text } }).parseAsync([
      'node', 'sop', 'task', 'review', '--input', reviewPath,
      '--apply-plan', reviewPlan.digest,
    ])
    expect(JSON.parse(output)).toMatchObject({ valid: true, applied: true })

    const statusPath = join(fixture.root, 'STATUS.md')
    writeFileSync(statusPath, `Task ${fixture.taskId}. Next: release planning.\n`)
    const closurePath = join(taskDirectory, 'closure.yaml')
    writeFileSync(closurePath, stringify({
      schemaVersion: 2,
      artifactType: 'sop-closure-v2',
      taskId: fixture.taskId,
      closer: { id: 'independent-reviewer', trustLevel: 'local-claim' },
      contract: {
        path: fixture.contractPath,
        sha256: sha256(readFileSync(fixture.contractPath)),
        digest: fixture.contract.contractDigest,
      },
      candidate: {
        path: fixture.candidatePath,
        sha256: sha256(readFileSync(fixture.candidatePath)),
        digest: canonicalDigest(fixture.candidate),
      },
      verification: {
        path: fixture.verificationPath,
        sha256: sha256(readFileSync(fixture.verificationPath)),
      },
      review: { path: reviewPath, sha256: sha256(readFileSync(reviewPath)) },
      acceptedEventDigest: reviewPlan.event.eventDigest,
      statusArtifacts: [{ path: statusPath, sha256: sha256(readFileSync(statusPath)) }],
      nextAction: 'release planning',
      userActionRequired: false,
    }))
    const ledgerPath = join(taskDirectory, 'ledger.jsonl')
    const ledgerBefore = readFileSync(ledgerPath, 'utf8')
    output = ''

    await buildProgram({ write: (text) => { output += text } }).parseAsync([
      'node', 'sop', 'task', 'close', '--input', closurePath,
    ])
    const closePlan = JSON.parse(output) as { valid: boolean; transitionPlan: { digest: string } }
    expect(closePlan.valid).toBe(true)
    expect(readFileSync(ledgerPath, 'utf8')).toBe(ledgerBefore)

    output = ''
    await buildProgram({ write: (text) => { output += text } }).parseAsync([
      'node', 'sop', 'task', 'close', '--input', closurePath,
      '--apply-plan', closePlan.transitionPlan.digest,
    ])
    expect(JSON.parse(output)).toMatchObject({ valid: true, applied: true, errors: [] })
    expect(readFileSync(ledgerPath, 'utf8').split('\n').filter(Boolean)).toHaveLength(
      ledgerBefore.split('\n').filter(Boolean).length + 1,
    )
  })
})
