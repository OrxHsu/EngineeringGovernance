import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import { parse } from 'yaml'

import { startTask } from '../../src/commands/task-start.js'
import { canonicalDigest } from '../../src/model/digest.js'
import {
  applyTaskTransition,
  planTaskTransition,
  readTaskLedger,
} from '../../src/state/ledger.js'
import { validateAcceptanceAuthority } from '../../src/state/transitions.js'

const temporaryDirectories: string[] = []

function fixture(): { root: string; contract: Record<string, unknown> } {
  const created = mkdtempSync(join(tmpdir(), 'sop-v2-ledger-'))
  temporaryDirectories.push(created)
  const root = realpathSync(created)
  execFileSync('git', ['-C', root, 'init', '-b', 'main'])
  execFileSync('git', ['-C', root, 'config', 'user.email', 'test@example.com'])
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Test'])
  writeFileSync(join(root, 'baseline.txt'), 'baseline\n')
  execFileSync('git', ['-C', root, 'add', 'baseline.txt'])
  execFileSync('git', ['-C', root, 'commit', '-m', 'baseline'])
  const task = startTask({
    schemaVersion: 2,
    taskId: 'ledger-task',
    implementationOwner: ' Codex ',
    objective: 'Prove append-only transitions.',
    scope: ['src/**'],
    nonGoals: [],
    authorityInputs: ['spec.md'],
    repositories: [{ id: 'root', path: root }],
    acceptance: [{
      id: 'AC-01',
      observation: 'The ledger is valid.',
      positiveCases: ['ordered event'],
      negativeCases: ['forged event'],
      evidenceKind: 'static',
      command: {
        repositoryId: 'root', cwd: '.', executable: process.execPath, arguments: ['--version'],
      },
      observerPolicy: {
        expectedExitCode: 0,
        output: 'nonempty',
        checkoutMutation: 'forbidden',
        replay: 'not-required',
      },
    }],
    authorizationRequirements: [],
    openChoices: [],
    signals: { mutation: true, classificationComplete: true },
  })
  for (const artifact of task.artifacts) {
    const path = join(root, artifact.path)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, artifact.content)
  }
  const contract = parse(task.artifacts[0]!.content) as Record<string, unknown>
  return { root, contract }
}

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('v2 task ledger', () => {
  it('plans and atomically applies an exact legal transition', () => {
    const { root, contract } = fixture()
    const triggerPath = join(root, '.delivery/tasks/ledger-task/in-progress.json')
    writeFileSync(triggerPath, '{"reason":"implementation started"}\n')

    const plan = planTaskTransition({
      projectRoot: root,
      taskId: 'ledger-task',
      actorId: 'CODEX',
      to: 'IN_PROGRESS',
      artifacts: [{ kind: 'transition-request', path: triggerPath }],
    })
    expect(plan.event).toMatchObject({
      sequence: 2,
      from: 'DEFINED',
      to: 'IN_PROGRESS',
      actorId: 'codex',
      contractDigest: contract.contractDigest,
    })
    expect(applyTaskTransition(plan, '0'.repeat(64))).toEqual({
      applied: false,
      errors: ['TASK_TRANSITION_PLAN_DIGEST_MISMATCH'],
    })
    expect(applyTaskTransition(plan, plan.digest)).toEqual({ applied: true, errors: [] })

    const ledger = readTaskLedger({
      projectRoot: root,
      taskId: 'ledger-task',
      contractDigest: String(contract.contractDigest),
      contractSha256: plan.contract.sha256,
      implementationOwner: 'codex',
    })
    expect(ledger.valid).toBe(true)
    expect(ledger.currentState).toBe('IN_PROGRESS')
    expect(ledger.events).toHaveLength(2)
  })

  it('rejects illegal jumps, forged history, and normalized self-review aliases', () => {
    const { root } = fixture()
    const triggerPath = join(root, '.delivery/tasks/ledger-task/invalid.json')
    writeFileSync(triggerPath, '{}\n')
    expect(() => planTaskTransition({
      projectRoot: root,
      taskId: 'ledger-task',
      actorId: 'reviewer',
      to: 'IN_PROGRESS',
      artifacts: [{ kind: 'transition-request', path: triggerPath }],
    })).toThrow('TASK_TRANSITION_IMPLEMENTATION_OWNER_REQUIRED')
    const forged = planTaskTransition({
      projectRoot: root,
      taskId: 'ledger-task',
      actorId: 'codex',
      to: 'IN_PROGRESS',
      artifacts: [{ kind: 'transition-request', path: triggerPath }],
    })
    forged.event.actorId = 'reviewer'
    const { eventDigest: _eventDigest, ...unsignedEvent } = forged.event
    forged.event.eventDigest = canonicalDigest(unsignedEvent)
    const { digest: _digest, ...unsignedPlan } = forged
    forged.digest = canonicalDigest(unsignedPlan)
    expect(applyTaskTransition(forged, forged.digest).errors).toContain(
      'TASK_TRANSITION_IMPLEMENTATION_OWNER_REQUIRED',
    )
    expect(() => planTaskTransition({
      projectRoot: root,
      taskId: 'ledger-task',
      actorId: 'reviewer',
      to: 'ACCEPTED',
      artifacts: [{ kind: 'review', path: triggerPath }],
    })).toThrow('TASK_TRANSITION_NOT_ALLOWED:DEFINED:ACCEPTED')

    const ledgerPath = join(root, '.delivery/tasks/ledger-task/ledger.jsonl')
    writeFileSync(ledgerPath, readFileSync(ledgerPath, 'utf8').replace('DEFINED', 'CLOSED'))
    expect(() => planTaskTransition({
      projectRoot: root,
      taskId: 'ledger-task',
      actorId: 'codex',
      to: 'IN_PROGRESS',
      artifacts: [{ kind: 'transition-request', path: triggerPath }],
    })).toThrow('TASK_LEDGER_INVALID')

    expect(validateAcceptanceAuthority('R3', 'Codex', ' codex ')).toEqual({
      valid: false,
      errors: ['INDEPENDENT_REVIEW_REQUIRED'],
    })
  })
})
