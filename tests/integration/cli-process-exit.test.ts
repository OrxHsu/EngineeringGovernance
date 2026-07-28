import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, expect, it } from 'vitest'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { recursive: true, force: true })
  }
})

it('returns a non-zero process exit when a validation decision is invalid', () => {
  const project = mkdtempSync(join(tmpdir(), 'sop-invalid-project-'))
  temporaryDirectories.push(project)
  const executable = join(process.cwd(), 'node_modules', '.bin', 'tsx')
  const result = spawnSync(executable, [
    'src/cli/main.ts',
    'check',
    project,
    '--json',
  ], { encoding: 'utf8' })

  expect(result.stdout).toContain('PROJECT_POLICY_MISSING')
  expect(result.status).not.toBe(0)
})
