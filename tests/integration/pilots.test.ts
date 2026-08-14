import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { planAdoption } from '../../src/commands/adopt.js'
import { applyAdoption } from '../../src/commands/init.js'
import { testRunnerBundle } from '../helpers/runner-bundle.js'

const executable = join(process.cwd(), 'node_modules', '.bin', 'tsx')
const temporaryDirectories: string[] = []
const legacyPilots = [
  ['tests/pilots/r1-local/start.yaml', 'pilot-r1-local'],
  ['tests/pilots/r2-review/start.yaml', 'pilot-r2-review'],
  ['tests/pilots/r3-authorization/start.yaml', 'pilot-r3-authorization'],
] as const

function runCli(arguments_: string[]): ReturnType<typeof spawnSync> {
  return spawnSync(executable, ['src/cli/main.ts', ...arguments_], {
    cwd: process.cwd(),
    encoding: 'utf8',
  })
}

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { recursive: true, force: true })
  }
})

describe('breaking-version workflow pilots', () => {
  it('keeps every historical pilot available through explicit read-only inspection', () => {
    for (const [path, taskId] of legacyPilots) {
      const result = runCli(['legacy', 'inspect', '--input', path])
      expect(result.status, result.stderr || result.stdout).toBe(0)
      expect(JSON.parse(result.stdout)).toEqual({
        valid: true,
        errors: [],
        kind: 'task-start',
        schemaVersion: null,
        summary: { taskId, implementationOwner: 'codex-pilot' },
      })
    }
  })

  it('rejects every historical pilot on the active v2 start path without creating task state', () => {
    const project = mkdtempSync(join(tmpdir(), 'sop-legacy-pilots-'))
    temporaryDirectories.push(project)
    const adoption = planAdoption(project, { runnerBundlePath: testRunnerBundle() })
    applyAdoption(adoption, adoption.digest)

    for (const [path, taskId] of legacyPilots) {
      const result = runCli(['task', 'start', '--project', project, '--input', path])
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('ACTIVE_COMMAND_REQUIRES_SCHEMA_VERSION_2')
      expect(existsSync(join(project, '.delivery', 'tasks', taskId))).toBe(false)
    }
  })
}, 30_000)
