import { readFile } from 'node:fs/promises'

import { expect, it } from 'vitest'

import { renderCoreBlock } from '../../src/adapters/render.js'

it('renders the reviewed generic AGENTS block', async () => {
  const golden = await readFile('tests/golden/adapters/generic-agents.md', 'utf8')
  expect(renderCoreBlock({ version: '2.0.0', digest: 'a'.repeat(64) })).toBe(golden)
})
