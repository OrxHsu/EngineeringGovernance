import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { discoverProject, validateManagedPathOverlap } from '../../src/project/discover.js'
import { createManagedBlock, planManagedBlockWrite } from '../../src/project/managed-block.js'
import { applyPlannedWrites } from '../../src/project/mutate.js'

function git(repository: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: repository, encoding: 'utf8' }).trim()
}

function repository(): string {
  const path = mkdtempSync(join(tmpdir(), 'governance-project-'))
  git(path, 'init', '-b', 'main')
  git(path, 'config', 'user.email', 'test@example.com')
  git(path, 'config', 'user.name', 'Test')
  return path
}

describe('safe project adoption', () => {
  it('dry-runs without writing and applies while preserving local instructions', () => {
    const project = repository()
    const agents = join(project, 'AGENTS.md')
    writeFileSync(agents, '# Local rules\n\nKeep this text.\n')
    const block = createManagedBlock({ version: '1.0.0', digest: 'a'.repeat(64) })
    const write = planManagedBlockWrite(agents, block)

    expect(applyPlannedWrites([write], { dryRun: true })).toEqual({ applied: [] })
    expect(readFileSync(agents, 'utf8')).toBe('# Local rules\n\nKeep this text.\n')

    expect(applyPlannedWrites([write], { dryRun: false }).applied).toEqual([agents])
    const installed = readFileSync(agents, 'utf8')
    expect(installed).toContain('Keep this text.')
    expect(installed.match(/engineering-governance:start/g)).toHaveLength(1)

    const second = planManagedBlockWrite(agents, block)
    expect(second.after).toBe(installed)
  })

  it('stops if a managed file changes after planning', () => {
    const project = repository()
    const agents = join(project, 'AGENTS.md')
    writeFileSync(agents, '# Local rules\n')
    const write = planManagedBlockWrite(
      agents,
      createManagedBlock({ version: '1.0.0', digest: 'a'.repeat(64) }),
    )
    writeFileSync(agents, '# Concurrent change\n')

    expect(() => applyPlannedWrites([write], { dryRun: false })).toThrow('MANAGED_FILE_CHANGED')
    expect(readFileSync(agents, 'utf8')).toBe('# Concurrent change\n')
  })

  it('distinguishes unrelated dirt from managed-path overlap', () => {
    const project = repository()
    writeFileSync(join(project, 'AGENTS.md'), '# Rules\n')
    writeFileSync(join(project, 'README.md'), '# Project\n')
    git(project, 'add', 'AGENTS.md', 'README.md')
    git(project, 'commit', '-m', 'baseline')
    writeFileSync(join(project, 'README.md'), '# User change\n')

    expect(validateManagedPathOverlap(discoverProject(project), ['AGENTS.md'])).toEqual({
      valid: true,
      errors: [],
    })

    writeFileSync(join(project, 'AGENTS.md'), '# Concurrent rules\n')
    expect(validateManagedPathOverlap(discoverProject(project), ['AGENTS.md']).errors).toEqual([
      'DIRTY_MANAGED_PATH:AGENTS.md',
    ])
  })

  it('discovers the owning source of a generated AGENTS target', () => {
    const project = repository()
    mkdirSync(join(project, 'Docs', 'rules'), { recursive: true })
    writeFileSync(join(project, 'Docs', 'rules', 'agents.md'), '# Canonical rules\n')
    writeFileSync(
      join(project, 'AGENTS.md'),
      '<!-- generated-from: Docs/rules/agents.md -->\n# Generated rules\n',
    )

    expect(discoverProject(project).agentEntrypoints).toContainEqual({
      target: 'AGENTS.md',
      owningSource: 'Docs/rules/agents.md',
    })
  })
})
