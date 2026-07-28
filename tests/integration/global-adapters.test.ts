import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, expect, it } from 'vitest'

import { buildProgram } from '../../src/cli/main.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async (path) => rm(path, {
    recursive: true,
    force: true,
  })))
})

it('keeps global Codex installation dry-run-first and digest-confirmed', async () => {
  const homeDirectory = await mkdtemp(join(tmpdir(), 'sop-global-home-'))
  temporaryDirectories.push(homeDirectory)
  const { mkdir } = await import('node:fs/promises')
  await mkdir(join(homeDirectory, '.codex'), { recursive: true })
  const agentsPath = join(homeDirectory, '.codex', 'AGENTS.md')
  await writeFile(agentsPath, '# Local global instructions\n')

  let output = ''
  await buildProgram({ write: (text) => { output += text } }).parseAsync([
    'node',
    'sop',
    'global',
    'install',
    '--tool',
    'codex',
    '--home',
    homeDirectory,
  ])
  const dryRun = JSON.parse(output) as {
    digest: string
    writes: Array<{ path: string; beforeDigest: string | null; afterDigest: string }>
  }
  expect(dryRun.digest).toMatch(/^[a-f0-9]{64}$/u)
  expect(dryRun.writes.map((write) => write.path)).toEqual([
    agentsPath,
    join(homeDirectory, '.codex', 'skills', 'delivery-sop', 'SKILL.md'),
    join(homeDirectory, '.codex', 'skills', 'delivery-sop', 'agents', 'openai.yaml'),
    join(homeDirectory, '.codex', 'skills', 'delivery-sop', '.engineering-governance-skill.json'),
  ])
  expect(dryRun.writes.every((write) => 'afterDigest' in write && !('after' in write))).toBe(true)
  await expect(readFile(agentsPath, 'utf8')).resolves.toBe('# Local global instructions\n')

  output = ''
  await buildProgram({ write: (text) => { output += text } }).parseAsync([
    'node',
    'sop',
    'global',
    'install',
    '--tool',
    'codex',
    '--home',
    homeDirectory,
    '--apply-plan',
    dryRun.digest,
  ])
  expect(JSON.parse(output)).toMatchObject({ applied: dryRun.writes.map((write) => write.path) })
  expect(await readFile(agentsPath, 'utf8')).toContain('engineering-governance:start')
  await expect(readFile(
    join(homeDirectory, '.codex', 'skills', 'delivery-sop', 'SKILL.md'),
    'utf8',
  )).resolves.toContain('name: delivery-sop')

  output = ''
  await buildProgram({ write: (text) => { output += text } }).parseAsync([
    'node',
    'sop',
    'global',
    'check',
    '--tool',
    'codex',
    '--home',
    homeDirectory,
  ])
  expect(JSON.parse(output)).toEqual({ valid: true, errors: [] })
})
