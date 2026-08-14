import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import { parse } from 'yaml'

import { startTask } from '../../src/commands/task-start.js'
import { validateDocument } from '../../src/policy/load.js'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { recursive: true, force: true })
  }
})

function project(): string {
  const path = mkdtempSync(join(tmpdir(), 'sop-v2-contract-'))
  temporaryDirectories.push(path)
  return path
}

describe('hardened task contracts', () => {
  it('freezes R1 ownership, repositories, evidence kinds, commands, and observer policy', () => {
    const repository = project()
    const result = startTask({
      schemaVersion: 2,
      taskId: 'bounded-local-edit',
      implementationOwner: ' Codex ',
      objective: 'Make one bounded local edit.',
      scope: ['src/example.ts'],
      nonGoals: ['deployment'],
      authorityInputs: ['spec.md'],
      repositories: [{ id: 'root', path: repository }],
      acceptance: [{
        id: 'AC-01',
        observation: 'The exact unit command passes without changing the checkout.',
        positiveCases: ['valid implementation'],
        negativeCases: ['missing implementation'],
        evidenceKind: 'unit',
        command: {
          repositoryId: 'root',
          cwd: '.',
          executable: process.execPath,
          arguments: ['-e', "process.stdout.write('pass\\n')"],
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
      openChoices: ['internal name'],
      signals: { mutation: true, classificationComplete: true },
    })

    expect(result.risk).toBe('R1')
    expect(result.artifacts.map((artifact) => artifact.path)).toEqual([
      '.delivery/tasks/bounded-local-edit/contract.yaml',
      '.delivery/tasks/bounded-local-edit/ledger.jsonl',
    ])

    const contract = parse(result.artifacts[0]!.content) as Record<string, unknown>
    expect(contract).toMatchObject({
      schemaVersion: 2,
      taskId: 'bounded-local-edit',
      implementationOwner: 'codex',
      repositories: [{ id: 'root', path: realpathSync(repository) }],
      evidenceFreshnessMs: 86_400_000,
      sourcePolicy: { mode: 'independent' },
      acceptance: [{
        id: 'AC-01',
        evidenceKind: 'unit',
        command: {
          repositoryId: 'root',
          cwd: '.',
          executable: process.execPath,
          arguments: ['-e', "process.stdout.write('pass\\n')"],
        },
        observerPolicy: {
          expectedExitCode: 0,
          output: 'nonempty',
          checkoutMutation: 'forbidden',
          replay: 'required',
        },
      }],
    })
    expect(contract).not.toHaveProperty('state')
    expect(typeof contract.policyDigest).toBe('string')
    expect(validateDocument('task-contract', contract)).toEqual({ valid: true, errors: [] })

    const events = result.artifacts[1]!.content.trim().split('\n').map((line) => (
      JSON.parse(line) as Record<string, unknown>
    ))
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      schemaVersion: 2,
      sequence: 1,
      previousEventDigest: null,
      from: null,
      to: 'DEFINED',
      actorId: 'codex',
    })
    expect(typeof events[0]!.eventDigest).toBe('string')
  })

  it('rejects duplicate repository IDs and acceptance commands that escape their repository', () => {
    const repository = project()
    const base = {
      schemaVersion: 2 as const,
      taskId: 'invalid-contract',
      implementationOwner: 'codex',
      objective: 'Reject an invalid contract.',
      scope: ['src/**'],
      nonGoals: [],
      authorityInputs: ['spec.md'],
      authorizationRequirements: [],
      sourcePolicy: { mode: 'independent' as const },
      openChoices: [],
      signals: { mutation: true, classificationComplete: true },
    }

    expect(() => startTask({
      ...base,
      repositories: [
        { id: 'root', path: repository },
        { id: 'root', path: repository },
      ],
      acceptance: [{
        id: 'AC-01',
        observation: 'Invalid duplicate repository.',
        positiveCases: ['never'],
        negativeCases: ['duplicate'],
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
    })).toThrow('TASK_REPOSITORY_IDS_DUPLICATED')

    expect(() => startTask({
      ...base,
      repositories: [{ id: 'root', path: repository }],
      acceptance: [{
        id: 'AC-01',
        observation: 'Invalid escaping cwd.',
        positiveCases: ['never'],
        negativeCases: ['escape'],
        evidenceKind: 'static',
        command: {
          repositoryId: 'root',
          cwd: '..',
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
    })).toThrow('TASK_GATE_CWD_OUTSIDE_REPOSITORY:AC-01')
  })
})
