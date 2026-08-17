import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { execFileSync } from 'node:child_process'

import { parse, stringify } from 'yaml'
import { afterEach, describe, expect, it } from 'vitest'

import { planAdoption, verifyAdoptedProject } from '../../src/commands/adopt.js'
import { applyAdoption } from '../../src/commands/init.js'
import { startTask } from '../../src/commands/task-start.js'
import { testRunnerBundle } from '../helpers/runner-bundle.js'

const temporaryDirectories: string[] = []

function temporaryProject(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix))
  temporaryDirectories.push(path)
  return path
}

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

function git(repository: string, ...arguments_: string[]): string {
  return execFileSync('git', ['-C', repository, ...arguments_], { encoding: 'utf8' }).trim()
}

function adopt(projectRoot: string): void {
  const plan = planAdoption(projectRoot, { runnerBundlePath: testRunnerBundle() })
  applyAdoption(plan, plan.digest)
}

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('adopted project verification', () => {
  it('keeps a policy-only partial adoption invalid', () => {
    const projectRoot = temporaryProject('sop-verify-partial-adoption-')
    const plan = planAdoption(projectRoot)
    applyAdoption(plan, plan.digest)
    expect(verifyAdoptedProject(projectRoot).errors).toContain('PROJECT_RUNNER_MISSING')
  })

  it('validates extensions and the exact managed adapter source', () => {
    const projectRoot = temporaryProject('sop-verify-adoption-')
    adopt(projectRoot)
    expect(verifyAdoptedProject(projectRoot)).toEqual({ valid: true, errors: [] })

    write(join(projectRoot, '.delivery', 'extensions.yaml'), 'schemaVersion: 1\nextensions: {}\n')
    expect(verifyAdoptedProject(projectRoot).errors).toContain('PROJECT_EXTENSIONS_INVALID')

    write(join(projectRoot, '.delivery', 'extensions.yaml'), 'schemaVersion: 1\nextensions: []\n')
    const agentsPath = join(projectRoot, 'AGENTS.md')
    write(
      agentsPath,
      readFileSync(agentsPath, 'utf8').replace('Global Development Workflow', 'Local imitation'),
    )
    expect(verifyAdoptedProject(projectRoot).errors).toContain(
      'AGENT_ADAPTER_SOURCE_DRIFTED:AGENTS.md',
    )
  }, 15_000)

  it('checks ProjTrav generated targets without authoring them directly', () => {
    const projectRoot = temporaryProject('sop-verify-projtrav-')
    git(projectRoot, 'init', '-b', 'main')
    git(projectRoot, 'config', 'user.email', 'test@example.com')
    git(projectRoot, 'config', 'user.name', 'Test')
    const sources = [
      'Docs/AGENTS.md',
      'Docs/rules/workspace-agent-entrypoint.md',
      'Docs/rules/backend-agent-rules.md',
      'Docs/rules/ios-agent-rules.md',
    ]
    for (const source of sources) write(join(projectRoot, source), `# ${source}\n`)
    for (const target of [
      'AGENTS.md',
      'projtrav-server/AGENTS.md',
      'projtrav-server/.cursorrules',
      'projtrav-ios/AGENTS.md',
      'projtrav-ios/.cursorrules',
    ]) write(join(projectRoot, target), `# generated ${target}\n`)
    for (const nested of ['projtrav-server', 'projtrav-ios']) {
      const nestedRoot = join(projectRoot, nested)
      git(nestedRoot, 'init', '-b', 'main')
      git(nestedRoot, 'config', 'user.email', 'test@example.com')
      git(nestedRoot, 'config', 'user.name', 'Test')
      git(nestedRoot, 'add', 'AGENTS.md', '.cursorrules')
      git(nestedRoot, 'commit', '-m', 'baseline')
    }
    git(projectRoot, 'add', 'Docs', 'AGENTS.md')
    git(projectRoot, 'commit', '-m', 'baseline')

    adopt(projectRoot)
    expect(verifyAdoptedProject(projectRoot).errors).toContain(
      'AGENT_ADAPTER_TARGET_DRIFTED:AGENTS.md',
    )

    write(
      join(projectRoot, 'AGENTS.md'),
      readFileSync(join(projectRoot, 'Docs/rules/workspace-agent-entrypoint.md'), 'utf8'),
    )
    for (const target of ['projtrav-server/AGENTS.md', 'projtrav-server/.cursorrules']) {
      write(
        join(projectRoot, target),
        readFileSync(join(projectRoot, 'Docs/rules/backend-agent-rules.md'), 'utf8'),
      )
    }
    for (const target of ['projtrav-ios/AGENTS.md', 'projtrav-ios/.cursorrules']) {
      write(
        join(projectRoot, target),
        readFileSync(join(projectRoot, 'Docs/rules/ios-agent-rules.md'), 'utf8'),
      )
    }
    expect(verifyAdoptedProject(projectRoot)).toEqual({ valid: true, errors: [] })
  })

  it('validates a configured pinned runner and wrapper', () => {
    const projectRoot = temporaryProject('sop-verify-runner-')
    adopt(projectRoot)
    expect(verifyAdoptedProject(projectRoot)).toEqual({ valid: true, errors: [] })
    const archivePath = join(
      projectRoot,
      '.delivery/runtime/engineering-governance-2.1.0.tgz',
    )
    write(archivePath, 'forged archive\n')
    expect(verifyAdoptedProject(projectRoot).errors).toContain(
      'PROJECT_RUNNER_DIGEST_MISMATCH',
    )
  })

  it('preserves project artifact mappings during an upgrade', () => {
    const projectRoot = temporaryProject('sop-verify-upgrade-mapping-')
    adopt(projectRoot)
    const policyPath = join(projectRoot, '.delivery', 'policy.yaml')
    const policy = parse(readFileSync(policyPath, 'utf8')) as Record<string, unknown>
    const artifactMapping = {
      'accountability.eventsPath': '.delivery/accountability/events.jsonl',
      'accountability.registryPath': '.delivery/accountability/actors.jsonl',
      'accountability.ruleset': 'strict-v1',
    }
    policy.artifactMapping = artifactMapping
    policy.sopDigest = 'a'.repeat(64)
    write(policyPath, stringify(policy))

    const upgrade = planAdoption(projectRoot, { runnerBundlePath: testRunnerBundle() })
    applyAdoption(upgrade, upgrade.digest)

    const upgraded = parse(readFileSync(policyPath, 'utf8')) as {
      artifactMapping: Record<string, string>
    }
    expect(upgraded.artifactMapping).toEqual({
      ...artifactMapping,
      'accountability.policyLineage': 'a'.repeat(64),
    })
    expect(verifyAdoptedProject(projectRoot)).toEqual({ valid: true, errors: [] })
  })

  it('validates task contract schemas and canonical digests', () => {
    const projectRoot = temporaryProject('sop-verify-task-')
    git(projectRoot, 'init', '-b', 'main')
    git(projectRoot, 'config', 'user.email', 'test@example.com')
    git(projectRoot, 'config', 'user.name', 'Test')
    write(join(projectRoot, 'baseline.txt'), 'baseline\n')
    git(projectRoot, 'add', 'baseline.txt')
    git(projectRoot, 'commit', '-m', 'baseline')
    adopt(projectRoot)
    const task = startTask({
      schemaVersion: 2,
      taskId: 'cross-module-task',
      implementationOwner: 'codex',
      objective: 'Deliver one bounded behavior.',
      scope: ['src/**'],
      nonGoals: ['deployment'],
      authorityInputs: ['spec.md'],
      acceptance: [{
        id: 'AC-01',
        observation: 'The named command passes.',
        positiveCases: ['valid input'],
        negativeCases: ['missing input'],
        evidenceKind: 'unit',
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
      repositories: [{ id: 'root', path: projectRoot }],
      authorizationRequirements: [],
      openChoices: ['internal names'],
      signals: { crossModule: true },
    })
    for (const artifact of task.artifacts) {
      write(join(projectRoot, artifact.path), artifact.content)
    }
    const contractArtifact = task.artifacts.find((artifact) => artifact.path.endsWith('/contract.yaml'))
    expect(contractArtifact).toBeDefined()
    const contractPath = join(projectRoot, contractArtifact!.path)
    expect(verifyAdoptedProject(projectRoot)).toEqual({ valid: true, errors: [] })

    const contract = parse(readFileSync(contractPath, 'utf8')) as Record<string, unknown>
    contract.objective = 'Changed without refreezing the digest.'
    write(contractPath, stringify(contract))
    expect(verifyAdoptedProject(projectRoot).errors).toContain(
      'TASK_CONTRACT_DIGEST_MISMATCH:cross-module-task',
    )
  })
})
