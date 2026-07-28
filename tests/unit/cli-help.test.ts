import { describe, expect, it } from 'vitest'

import { buildProgram, normalizeCliArguments } from '../../src/cli/main.js'

describe('sop CLI', () => {
  it('registers the required top-level commands', () => {
    const names = buildProgram().commands.map((command) => command.name())

    expect(names).toEqual(['init', 'adopt', 'check', 'upgrade', 'task', 'global'])
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
