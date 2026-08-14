import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import { parse } from 'yaml'

import { startTask } from '../../src/commands/task-start.js'
import { validateProjectTaskGraph } from '../../src/project/task-graph.js'

const roots: string[] = []

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('contract-review graph gate', () => {
  it('allows a newly created R2 task to wait in DEFINED before review', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'sop-contract-review-graph-')))
    roots.push(root)
    execFileSync('git', ['-C', root, 'init', '-b', 'main'])
    execFileSync('git', ['-C', root, 'config', 'user.email', 'test@example.com'])
    execFileSync('git', ['-C', root, 'config', 'user.name', 'Test'])
    writeFileSync(join(root, 'authority.md'), 'authority\n')
    execFileSync('git', ['-C', root, 'add', 'authority.md'])
    execFileSync('git', ['-C', root, 'commit', '-m', 'baseline'])

    const taskId = 'graph-readiness-task'
    const result = startTask({
      schemaVersion: 2,
      taskId,
      implementationOwner: 'codex',
      objective: 'Exercise the waiting state.',
      scope: ['src/**'],
      nonGoals: ['deployment'],
      authorityInputs: ['authority.md'],
      repositories: [{ id: 'root', path: root }],
      acceptance: [{
        id: 'AC-01', observation: 'The graph accepts waiting.', positiveCases: ['pass'], negativeCases: ['reject'],
        evidenceKind: 'unit', command: { repositoryId: 'root', cwd: '.', executable: process.execPath, arguments: ['--version'] },
        observerPolicy: { expectedExitCode: 0, output: 'nonempty', checkoutMutation: 'forbidden', replay: 'required' },
      }],
      authorizationRequirements: [],
      openChoices: [],
      signals: { crossModule: true, classificationComplete: true },
    }, { projectExtensions: [] })
    for (const artifact of result.artifacts) {
      const path = join(root, artifact.path)
      mkdirSync(join(path, '..'), { recursive: true })
      writeFileSync(path, artifact.content)
    }
    const contract = parse(readFileSync(join(root, `.delivery/tasks/${taskId}/contract.yaml`), 'utf8')) as Record<string, unknown>
    expect(contract.contractReadiness).toMatchObject({ required: true })
    const graph = validateProjectTaskGraph(root)
    expect(graph.valid).toBe(true)
    expect(graph.errors).toEqual([])
    expect(sha256(readFileSync(join(root, `.delivery/tasks/${taskId}/ledger.jsonl`)))).toHaveLength(64)
  })
})
