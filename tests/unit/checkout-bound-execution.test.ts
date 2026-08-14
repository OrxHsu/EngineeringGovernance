import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { startTask } from '../../src/commands/task-start.js'
import { captureCommandExecution } from '../../src/evidence/capture.js'
import { validateDocument } from '../../src/policy/load.js'

const temporaryDirectories: string[] = []

function git(repository: string, ...arguments_: string[]): string {
  return execFileSync('git', ['-C', repository, ...arguments_], { encoding: 'utf8' }).trim()
}

function repository(): string {
  const path = mkdtempSync(join(tmpdir(), 'sop-v2-execute-'))
  temporaryDirectories.push(path)
  git(path, 'init', '-b', 'main')
  git(path, 'config', 'user.email', 'test@example.com')
  git(path, 'config', 'user.name', 'Test')
  writeFileSync(join(path, 'source.txt'), 'stable\n')
  git(path, 'add', 'source.txt')
  git(path, 'commit', '-m', 'baseline')
  return path
}

function contract(repositoryPath: string, script: string): string {
  const task = startTask({
    schemaVersion: 2,
    taskId: 'checkout-bound-task',
    implementationOwner: 'codex',
    objective: 'Execute an exact contract gate.',
    scope: ['source.txt'],
    nonGoals: [],
    authorityInputs: ['spec.md'],
    repositories: [{ id: 'root', path: repositoryPath }],
    acceptance: [{
      id: 'AC-01',
      observation: 'The contract-owned command is observed.',
      positiveCases: ['command succeeds'],
      negativeCases: ['command mutates checkout'],
      evidenceKind: 'unit',
      command: {
        repositoryId: 'root',
        cwd: '.',
        executable: process.execPath,
        arguments: ['-e', script],
      },
      observerPolicy: {
        expectedExitCode: 0,
        output: 'nonempty',
        checkoutMutation: 'forbidden',
        replay: 'required',
      },
    }],
    authorizationRequirements: [],
    sourcePolicy: { mode: 'independent' },
    openChoices: [],
    signals: { mutation: true, classificationComplete: true },
  })
  for (const artifact of task.artifacts) {
    const path = join(repositoryPath, artifact.path)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, artifact.content)
  }
  return join(repositoryPath, task.artifacts[0]!.path)
}

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { recursive: true, force: true })
  }
})

describe('checkout-bound execution', () => {
  it('loads the command from the contract and records exact before/after snapshots', () => {
    const root = repository()
    contract(root, "process.stdout.write('observed\\n')")
    const outputPath = join(root, '.delivery/tasks/checkout-bound-task/receipts/run-1/AC-01.json')

    const artifact = captureCommandExecution({
      schemaVersion: 2,
      projectRoot: root,
      taskId: 'checkout-bound-task',
      acceptanceId: 'AC-01',
      runId: 'run-1',
    })

    expect(artifact).toMatchObject({
      schemaVersion: 2,
      artifactType: 'sop-command-execution-v2',
      taskId: 'checkout-bound-task',
      acceptanceId: 'AC-01',
      runId: 'run-1',
      command: {
        executable: process.execPath,
        arguments: ['-e', "process.stdout.write('observed\\n')"],
      },
      exitCode: 0,
      stdout: 'observed\n',
      stderr: '',
      policyErrors: [],
    })
    expect(artifact.repositoriesBefore).toEqual(artifact.repositoriesAfter)
    expect(artifact.repositoriesBefore[0]).toMatchObject({
      id: 'root',
      head: git(root, 'rev-parse', 'HEAD'),
      tree: git(root, 'rev-parse', 'HEAD^{tree}'),
    })
    expect(validateDocument('execution-receipt', artifact)).toEqual({ valid: true, errors: [] })
    expect(JSON.parse(readFileSync(outputPath, 'utf8'))).toEqual(artifact)
  })

  it('rejects caller-controlled commands and detects observer mutation', () => {
    const root = repository()
    const marker = join(root, 'marker.txt')
    contract(
      root,
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'changed\\n'); process.stdout.write('done\\n')`,
    )

    expect(() => captureCommandExecution({
      schemaVersion: 2,
      projectRoot: root,
      taskId: 'checkout-bound-task',
      acceptanceId: 'AC-01',
      runId: 'run-controlled',
      command: { executable: 'sh', arguments: ['-c', 'true'], cwd: '/tmp' },
    } as never)).toThrow('COMMAND_EXECUTION_COMMAND_CALLER_CONTROLLED')

    const artifact = captureCommandExecution({
      schemaVersion: 2,
      projectRoot: root,
      taskId: 'checkout-bound-task',
      acceptanceId: 'AC-01',
      runId: 'run-mutating',
    })
    expect(artifact.policyErrors).toContain('CHECKOUT_MUTATION_FORBIDDEN')
    expect(artifact.repositoriesBefore).not.toEqual(artifact.repositoriesAfter)
  })
})
