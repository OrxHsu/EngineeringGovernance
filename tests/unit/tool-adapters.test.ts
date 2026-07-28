import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { planClaudeAdapter } from '../../src/adapters/claude.js'
import { planCursorAdapter } from '../../src/adapters/cursor.js'
import { planGenericAdapter } from '../../src/adapters/generic.js'
import { planQoderAdapter } from '../../src/adapters/qoder.js'

const identity = { version: '1.0.0', digest: 'a'.repeat(64) }
const temporaryDirectories: string[] = []

async function project(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'sop-tool-adapter-'))
  temporaryDirectories.push(path)
  return path
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async (path) => rm(path, {
    recursive: true,
    force: true,
  })))
})

describe('project tool adapters', () => {
  it('routes Qoder through the authoritative AGENTS file and never .qoder/rules', async () => {
    const projectRoot = await project()
    const agentsPath = join(projectRoot, 'AGENTS.md')
    await writeFile(agentsPath, '# Project authority\n')

    const decision = planQoderAdapter({ projectRoot, identity })
    expect(decision.owningSource).toBe(agentsPath)
    expect(decision.generatedTargets).toEqual([])
    expect(decision.plannedWrites.map((write) => write.path)).toEqual([agentsPath])
    expect(JSON.stringify(decision)).not.toContain('.qoder/rules')
    expect(decision.plannedWrites[0]!.after.endsWith('# Project authority\n')).toBe(true)
  })

  it('generates Cursor compatibility only when explicitly configured', async () => {
    const projectRoot = await project()
    await writeFile(join(projectRoot, 'AGENTS.md'), '# Project authority\n')

    const disabled = planCursorAdapter({ projectRoot, identity, compatibilityEnabled: false })
    expect(disabled.generatedTargets).toEqual([])
    expect(disabled.plannedWrites).toEqual([])

    const enabled = planCursorAdapter({ projectRoot, identity, compatibilityEnabled: true })
    const golden = await readFile('tests/golden/adapters/cursor-rule.mdc', 'utf8')
    expect(enabled.generatedTargets).toEqual([
      join(projectRoot, '.cursor', 'rules', 'engineering-governance.mdc'),
    ])
    expect(enabled.plannedWrites[0]!.after).toBe(golden)
  })

  it('makes Claude import the adjacent authoritative AGENTS file', async () => {
    const projectRoot = await project()
    await writeFile(join(projectRoot, 'AGENTS.md'), '# Project authority\n')
    const decision = planClaudeAdapter({ projectRoot })
    const golden = await readFile('tests/golden/adapters/claude-import.md', 'utf8')

    expect(decision.owningSource).toBe(join(projectRoot, 'AGENTS.md'))
    expect(decision.generatedTargets).toEqual([join(projectRoot, 'CLAUDE.md')])
    expect(decision.plannedWrites[0]!.after).toBe(golden)
  })

  it('creates a generic AGENTS file only when none exists', async () => {
    const projectRoot = await project()
    const created = planGenericAdapter({ projectRoot, identity })
    const golden = await readFile('tests/golden/adapters/qoder-agents.md', 'utf8')
    expect(created.plannedWrites).toHaveLength(1)
    expect(created.plannedWrites[0]!.after).toBe(golden)

    await writeFile(join(projectRoot, 'AGENTS.md'), '# Existing authority\n')
    const existing = planGenericAdapter({ projectRoot, identity })
    expect(existing.owningSource).toBe(join(projectRoot, 'AGENTS.md'))
    expect(existing.plannedWrites).toEqual([])
  })
})
