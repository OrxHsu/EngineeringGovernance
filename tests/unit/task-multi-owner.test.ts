import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import { parse } from 'yaml'

import { planTaskStart, startTask } from '../../src/commands/task-start.js'
import { implementationOwnersOf } from '../../src/model/ownership.js'
import { applyTaskTransition, planTaskTransition } from '../../src/state/ledger.js'

const temporary: string[] = []

function project(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'sop-multi-owner-')))
  temporary.push(root)
  execFileSync('git', ['-C', root, 'init', '-b', 'main'])
  execFileSync('git', ['-C', root, 'config', 'user.email', 'test@example.com'])
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Test'])
  writeFileSync(join(root, 'baseline.txt'), 'baseline\n')
  execFileSync('git', ['-C', root, 'add', 'baseline.txt'])
  execFileSync('git', ['-C', root, 'commit', '-m', 'baseline'])
  return root
}

function input(root: string, taskId: string, signals: Record<string, boolean>) {
  return {
    schemaVersion: 2 as const,
    taskId,
    implementationOwners: ['qoder', 'cursor'],
    objective: 'Exercise a task with multiple recorded implementation owners.',
    scope: ['implementation.txt'],
    nonGoals: [],
    authorityInputs: ['baseline.txt'],
    repositories: [{ id: 'root', path: root }],
    acceptance: [{
      id: 'AC-01',
      observation: 'The exact command passes.',
      positiveCases: ['an assigned owner acts'],
      negativeCases: ['an unassigned actor acts'],
      evidenceKind: 'unit' as const,
      command: { repositoryId: 'root', cwd: '.', executable: process.execPath, arguments: ['--version'] },
      observerPolicy: { expectedExitCode: 0, output: 'nonempty' as const, checkoutMutation: 'forbidden' as const, replay: 'not-required' as const },
    }],
    authorizationRequirements: [],
    openChoices: [],
    signals,
  }
}

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('multiple implementation owners', () => {
  it('freezes a canonical owner set and permits each assigned owner to act', () => {
    const root = project()
    const taskId = 'multi-owner-task'
    const result = startTask(input(root, taskId, { mutation: true, classificationComplete: true }))
    for (const artifact of result.artifacts) {
      const path = join(root, artifact.path)
      mkdirSync(join(path, '..'), { recursive: true })
      writeFileSync(path, artifact.content)
    }
    const contractPath = join(root, `.delivery/tasks/${taskId}/contract.yaml`)
    const contract = parse(result.artifacts[0]!.content) as Record<string, unknown>
    expect(contract.implementationOwners).toEqual(['cursor', 'qoder'])
    expect(contract).not.toHaveProperty('implementationOwner')
    expect(JSON.parse(result.artifacts[1]!.content).actorId).toBe('cursor')

    expect(() => planTaskTransition({
      projectRoot: root,
      taskId,
      actorId: 'outsider',
      to: 'IN_PROGRESS',
      artifacts: [{ kind: 'contract', path: contractPath }],
    })).toThrow('TASK_TRANSITION_IMPLEMENTATION_OWNER_REQUIRED')

    const plan = planTaskTransition({
      projectRoot: root,
      taskId,
      actorId: 'qoder',
      to: 'IN_PROGRESS',
      artifacts: [{ kind: 'contract', path: contractPath }],
    })
    expect(plan.event.actorId).toBe('qoder')
    expect(applyTaskTransition(plan, plan.digest)).toEqual({ applied: true, errors: [] })
  })

  it('rejects an R3 beta0-style input before the task-start plan can be applied', () => {
    const root = project()
    const legacyR3Input = input(root, 'r3-beta0-gap', { security: true })
    expect(() => planTaskStart(root, legacyR3Input)).toThrow(
      'TASK_START_REVIEW_READY_CONTRACT_REQUIRED',
    )
  })

  it('rejects ambiguous, non-string, and normalized-duplicate owner sets', () => {
    expect(() => implementationOwnersOf({})).toThrow('TASK_IMPLEMENTATION_OWNER_FIELDS_INVALID')
    expect(() => implementationOwnersOf({ implementationOwner: 'codex', implementationOwners: ['cursor'] })).toThrow(
      'TASK_IMPLEMENTATION_OWNER_FIELDS_INVALID',
    )
    expect(() => implementationOwnersOf({ implementationOwners: ['codex', 7] })).toThrow(
      'TASK_IMPLEMENTATION_OWNER_INVALID',
    )
    expect(() => implementationOwnersOf({ implementationOwners: ['Codex', ' codex '] })).toThrow(
      'TASK_IMPLEMENTATION_OWNERS_DUPLICATED',
    )
  })
})
