import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

import { afterEach, expect, it } from 'vitest'

import { planAdoption } from '../../src/commands/adopt.js'
import { applyAdoption } from '../../src/commands/init.js'

const temporaryDirectories: string[] = []

async function temporaryDirectory(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix))
  temporaryDirectories.push(path)
  return path
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async (path) => rm(path, {
    recursive: true,
    force: true,
  })))
})

it('runs a checksum-pinned project gate offline and rejects a mutated runner', async () => {
  const buildOutput = await temporaryDirectory('sop-bundle-')
  const build = spawnSync(process.execPath, [
    'scripts/build-runner-bundle.mjs',
    '--output',
    buildOutput,
  ], { encoding: 'utf8' })
  expect(build.status, build.stderr || build.stdout).toBe(0)
  const bundle = JSON.parse(build.stdout) as {
    archivePath: string
    version: string
    sha256: string
  }
  expect(bundle.version).toBe('0.1.0-dev')
  expect(bundle.sha256).toMatch(/^[a-f0-9]{64}$/u)

  const projectRoot = await temporaryDirectory('sop-portable-project-')
  const adoption = planAdoption(projectRoot, { runnerBundlePath: bundle.archivePath })
  expect(adoption.writes.map((write) => write.path)).toContain(join(
    projectRoot,
    '.delivery',
    'runtime',
    `engineering-governance-${bundle.version}.tgz`,
  ))
  expect(adoption.writes.map((write) => write.path)).toContain(join(
    projectRoot,
    '.delivery',
    'bin',
    'check-delivery-policy.sh',
  ))
  applyAdoption(adoption, adoption.digest)

  const wrapper = join(projectRoot, '.delivery', 'bin', 'check-delivery-policy.sh')
  const environment = {
    ...process.env,
    npm_config_offline: 'true',
    npm_config_registry: 'http://127.0.0.1:9',
  }
  const accepted = spawnSync('sh', [wrapper], { encoding: 'utf8', env: environment })
  expect(accepted.status, accepted.stderr || accepted.stdout).toBe(0)
  expect(accepted.stdout).toContain('"valid": true')

  const agentsPath = join(projectRoot, 'AGENTS.md')
  const agents = await readFile(agentsPath, 'utf8')
  await writeFile(
    agentsPath,
    agents.replace(/Governance digest: `[^`]+`/u, `Governance digest: \`${'f'.repeat(64)}\``),
  )
  const drifted = spawnSync('sh', [wrapper], { encoding: 'utf8', env: environment })
  expect(drifted.stdout).toContain('"valid": false')
  expect(drifted.status).not.toBe(0)

  const policy = await readFile(join(projectRoot, '.delivery', 'policy.yaml'), 'utf8')
  expect(policy).toContain(`sha256: ${bundle.sha256}`)
  const installedArchive = join(
    projectRoot,
    '.delivery',
    'runtime',
    `engineering-governance-${bundle.version}.tgz`,
  )
  await appendFile(installedArchive, 'forged')
  const rejected = spawnSync('sh', [wrapper], { encoding: 'utf8', env: environment })
  expect(rejected.status).not.toBe(0)
  expect(rejected.stderr).toContain('RUNNER_DIGEST_MISMATCH')
}, 15_000)
