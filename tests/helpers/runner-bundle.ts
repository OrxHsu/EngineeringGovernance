import { spawnSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let cachedBundlePath: string | undefined

export function testRunnerBundle(): string {
  if (cachedBundlePath !== undefined) return cachedBundlePath
  const outputDirectory = mkdtempSync(join(tmpdir(), 'sop-test-runner-'))
  const result = spawnSync(process.execPath, [
    'scripts/build-runner-bundle.mjs',
    '--output',
    outputDirectory,
  ], { cwd: process.cwd(), encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`TEST_RUNNER_BUILD_FAILED:${result.stderr || result.stdout}`)
  }
  cachedBundlePath = (JSON.parse(result.stdout) as { archivePath: string }).archivePath
  return cachedBundlePath
}
