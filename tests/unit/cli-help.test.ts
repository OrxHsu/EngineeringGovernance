import { describe, expect, it } from 'vitest'

import { buildProgram, normalizeCliArguments } from '../../src/cli/main.js'

describe('sop CLI', () => {
  it('registers the required top-level commands', () => {
    const names = buildProgram().commands.map((command) => command.name())

    expect(names).toEqual([
      'init',
      'adopt',
      'unadopt',
      'check',
      'upgrade',
      'task',
      'contract',
      'accountability',
      'legacy',
      'global',
    ])
    const task = buildProgram().commands.find((command) => command.name() === 'task')!
    expect(task.commands.map((command) => command.name())).toEqual(expect.arrayContaining([
      'preflight', 'transition', 'contract-review-request', 'review-summary', 'verify-clean',
    ]))
    const contract = buildProgram().commands.find((command) => command.name() === 'contract')!
    expect(contract.commands.map((command) => command.name())).toContain('self-check')
    const accountability = buildProgram().commands.find((command) => command.name() === 'accountability')!
    expect(accountability.commands.map((command) => command.name())).toEqual(expect.arrayContaining([
      'status', 'gates', 'recovery-plan', 'incident-record',
    ]))
  })
})

it('accepts the pnpm script argument separator', () => {
  expect(normalizeCliArguments(['node', 'sop', '--', 'global', 'install'])).toEqual([
    'node',
    'sop',
    'global',
    'install',
  ])
})
