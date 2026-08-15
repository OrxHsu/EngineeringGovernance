import { appendFile, chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
  expect(bundle.version).toBe('2.1.0-beta.0')
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
}, 30_000)

it('fails closed before npm install on an unsupported Node runtime', async () => {
  const projectRoot = await temporaryDirectory('sop-portable-node-version-')
  const buildOutput = await temporaryDirectory('sop-portable-node-bundle-')
  const build = spawnSync(process.execPath, [
    'scripts/build-runner-bundle.mjs',
    '--output',
    buildOutput,
  ], { encoding: 'utf8' })
  expect(build.status, build.stderr || build.stdout).toBe(0)
  const bundle = JSON.parse(build.stdout) as { archivePath: string }
  const adoption = planAdoption(projectRoot, { runnerBundlePath: bundle.archivePath })
  applyAdoption(adoption, adoption.digest)

  const fakeBin = await temporaryDirectory('sop-portable-fake-node-')
  const fakeNode = join(fakeBin, 'node')
  const fakeNpm = join(fakeBin, 'npm')
  await writeFile(fakeNode, '#!/bin/sh\nif [ "$1" = "-p" ]; then echo 25.9.0; fi\nexit 0\n')
  await writeFile(fakeNpm, '#!/bin/sh\nexit 0\n')
  await chmod(fakeNode, 0o755)
  await chmod(fakeNpm, 0o755)

  const wrapper = join(projectRoot, '.delivery', 'bin', 'check-delivery-policy.sh')
  const fallbackWrapper = join(projectRoot, '.delivery', 'bin', 'check-fallback-node.sh')
  const wrapperText = await readFile(wrapper, 'utf8')
  await writeFile(
    fallbackWrapper,
    wrapperText.replace(
      /if \[ -x \/opt\/homebrew\/opt\/node@22\/bin\/node \]; then\n  PATH="\/opt\/homebrew\/opt\/node@22\/bin:\$PATH"\n  export PATH\nelif \[ -x \/usr\/local\/opt\/node@22\/bin\/node \]; then\n  PATH="\/usr\/local\/opt\/node@22\/bin:\$PATH"\n  export PATH\nfi\n\n/u,
      '',
    ),
  )
  const result = spawnSync('/bin/sh', [fallbackWrapper], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ''}` },
  })
  expect(result.status).not.toBe(0)
  expect(result.stderr).toContain('NODE_VERSION_UNSUPPORTED:25.9.0')
}, 30_000)
