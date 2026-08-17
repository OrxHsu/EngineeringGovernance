import { spawnSync, execFileSync } from 'node:child_process'
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { planAdoption } from '../../src/commands/adopt.js'

const temporaryDirectories: string[] = []
let baselineArchive = ''
let archiveEntries: string[] = []
let buildOutputRoot = ''

function temporaryDirectory(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix))
  temporaryDirectories.push(path)
  return path
}

function archiveName(): string {
  return baselineArchive.split('/').at(-1)!
}

function repackedArchive(mutate: (packageRoot: string) => void): string {
  const root = temporaryDirectory('sop-runner-adversarial-')
  const extraction = join(root, 'extract')
  mkdirSync(extraction)
  execFileSync('/usr/bin/tar', ['-xzf', baselineArchive, '-C', extraction])
  mutate(join(extraction, 'package'))
  const archive = join(root, archiveName())
  execFileSync('/usr/bin/tar', ['-czf', archive, '-C', extraction, 'package'])
  return archive
}

function adoptionPlanFor(archive: string): () => unknown {
  const project = temporaryDirectory('sop-runner-consumer-')
  return () => planAdoption(project, { runnerBundlePath: archive })
}

beforeAll(() => {
  const output = temporaryDirectory('sop-runner-build-')
  buildOutputRoot = output
  const build = spawnSync(process.execPath, [
    'scripts/build-runner-bundle.mjs',
    '--output',
    output,
  ], { cwd: process.cwd(), encoding: 'utf8' })
  expect(build.status, build.stderr || build.stdout).toBe(0)
  baselineArchive = (JSON.parse(build.stdout) as { archivePath: string }).archivePath
  archiveEntries = execFileSync('/usr/bin/tar', ['-tzf', baselineArchive], { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
}, 30_000)

afterAll(() => {
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('runner release-bundle adversarial integrity', () => {
  it('builds the baseline runner only into the isolated temporary output', () => {
    expect(baselineArchive.startsWith(`${buildOutputRoot}/`)).toBe(true)
    expect(adoptionPlanFor(baselineArchive)).not.toThrow()
  })

  it('rejects a harmless mutation of compiled runner bytes', () => {
    const archive = repackedArchive((packageRoot) => {
      appendFileSync(join(packageRoot, 'dist/cli/main.js'), '\n// harmless adversarial mutation\n')
    })
    expect(adoptionPlanFor(archive)).toThrow(
      'RUNNER_ARCHIVE_IDENTITY_SOURCE_MISMATCH:dist/cli/main.js',
    )
  })

  it('rejects a harmless mutation of a bundled transitive dependency', () => {
    const transitiveEntry = archiveEntries.find((entry) => (
      /^package\/node_modules\/(?:ajv|commander|yaml)\/node_modules\/.+\.(?:c?js|mjs)$/u.test(entry)
    ))
    expect(transitiveEntry).toBeDefined()
    const relativePath = transitiveEntry!.slice('package/'.length)
    const archive = repackedArchive((packageRoot) => {
      appendFileSync(join(packageRoot, relativePath), '\n// harmless transitive mutation\n')
    })
    expect(adoptionPlanFor(archive)).toThrow(
      `RUNNER_ARCHIVE_DEPENDENCY_MISMATCH:${relativePath}`,
    )
  })

  it.each([
    'VERSION',
    'package.json',
    'dist/cli/main.js',
    'LICENSE',
    'NOTICE',
    'SECURITY.md',
    'CHANGELOG.md',
  ])('rejects an archive missing required release file %s', (relativePath) => {
    const archive = repackedArchive((packageRoot) => {
      rmSync(join(packageRoot, relativePath))
    })
    expect(adoptionPlanFor(archive)).toThrow(
      `RUNNER_ARCHIVE_ENTRY_INVALID:${relativePath}:0`,
    )
  })

  it('requires the runner build script when package.json exposes bundle:runner', () => {
    const packageJson = JSON.parse(execFileSync('/usr/bin/tar', [
      '-xOf', baselineArchive, 'package/package.json',
    ], { encoding: 'utf8' })) as { scripts?: Record<string, string> }
    expect(packageJson.scripts?.['bundle:runner']).toBe('node scripts/build-runner-bundle.mjs')
    expect(archiveEntries).toContain('package/scripts/build-runner-bundle.mjs')
    const archive = repackedArchive((packageRoot) => {
      rmSync(join(packageRoot, 'scripts/build-runner-bundle.mjs'))
    })
    expect(adoptionPlanFor(archive)).toThrow(
      'RUNNER_ARCHIVE_ENTRY_INVALID:scripts/build-runner-bundle.mjs:0',
    )
  })

  it('does not accept an altered archive as the expected governance identity', () => {
    const archive = repackedArchive((packageRoot) => {
      const path = join(packageRoot, 'dist/cli/main.js')
      appendFileSync(path, Buffer.from([0x0a, 0x2f, 0x2f, 0x20, 0x78, 0x0a]))
    })
    expect(readFileSync(archive).equals(readFileSync(baselineArchive))).toBe(false)
    expect(adoptionPlanFor(archive)).toThrow()
  })
})
