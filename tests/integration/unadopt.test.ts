import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'
import { parse, stringify } from 'yaml'

import { governanceIdentity, planAdoption } from '../../src/commands/adopt.js'
import { applyAdoption } from '../../src/commands/init.js'
import {
  applyUnadoption,
  planUnadoption,
  summarizeUnadoptionPlan,
} from '../../src/commands/unadopt.js'
import { readRunnerArchiveFile } from '../../src/project/runner-bundle.js'
import { testRunnerBundle } from '../helpers/runner-bundle.js'

const temporaryDirectories: string[] = []

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('safe project unadoption', () => {
  it('is digest-approved, drift-safe, and preserves task history and unrelated files', () => {
    const root = mkdtempSync(join(tmpdir(), 'sop-unadopt-'))
    temporaryDirectories.push(root)
    const agents = join(root, 'AGENTS.md')
    writeFileSync(agents, '# Project rules\n\nKeep this.\n')
    const adoption = planAdoption(root, { runnerBundlePath: testRunnerBundle() })
    applyAdoption(adoption, adoption.digest)

    const taskHistory = join(root, '.delivery/tasks/keep/history.json')
    const unknown = join(root, '.delivery/custom.txt')
    mkdirSync(join(taskHistory, '..'), { recursive: true })
    writeFileSync(taskHistory, '{"state":"closed"}\n')
    writeFileSync(unknown, 'preserve\n')

    const plan = planUnadoption(root)
    const summary = summarizeUnadoptionPlan(plan) as {
      removals: Array<{ path: string }>
      writes: Array<{ path: string }>
    }
    expect(summary.removals.map((item) => item.path)).not.toContain(taskHistory)
    expect(summary.writes).toContainEqual(expect.objectContaining({ path: realpathSync(agents) }))
    expect(readFileSync(agents, 'utf8')).toContain('engineering-governance:start')

    const extensionsPath = join(root, '.delivery/extensions.yaml')
    const extensionsBefore = readFileSync(extensionsPath, 'utf8')
    writeFileSync(extensionsPath, `${extensionsBefore}# concurrent edit\n`)
    expect(() => applyUnadoption(plan, plan.digest)).toThrow('UNADOPTION_TARGET_CHANGED')
    expect(existsSync(join(root, '.delivery/policy.yaml'))).toBe(true)
    expect(readFileSync(agents, 'utf8')).toContain('engineering-governance:start')

    writeFileSync(extensionsPath, extensionsBefore)
    expect(applyUnadoption(plan, plan.digest).applied.length).toBeGreaterThan(0)
    expect(readFileSync(agents, 'utf8')).toContain('Keep this.')
    expect(readFileSync(agents, 'utf8')).not.toContain('engineering-governance:start')
    expect(existsSync(join(root, '.delivery/policy.yaml'))).toBe(false)
    expect(existsSync(join(root, '.delivery/extensions.yaml'))).toBe(false)
    expect(existsSync(join(root, '.delivery/bin/check-delivery-policy.sh'))).toBe(false)
    expect(existsSync(join(root, `.delivery/runtime/engineering-governance-${governanceIdentity().version}.tgz`))).toBe(false)
    expect(readFileSync(taskHistory, 'utf8')).toContain('closed')
    expect(readFileSync(unknown, 'utf8')).toBe('preserve\n')
  }, 15_000)

  it('unadopts a pinned v1 project without forcing a v2 upgrade', () => {
    const root = mkdtempSync(join(tmpdir(), 'sop-unadopt-v1-'))
    temporaryDirectories.push(root)
    const adoption = planAdoption(root)
    applyAdoption(adoption, adoption.digest)

    const legacyBlock = [
      '<!-- engineering-governance:start -->',
      'legacy managed instructions',
      '<!-- engineering-governance:end -->',
    ].join('\n')
    const agentsPath = join(root, 'AGENTS.md')
    writeFileSync(agentsPath, `${legacyBlock}\n`)
    const policyPath = join(root, '.delivery/policy.yaml')
    const policy = parse(readFileSync(policyPath, 'utf8')) as {
      sopVersion: string
      sopDigest: string
      adapters: Array<{ digest: string }>
      runner?: { version: string; path: string; sha256: string }
    }
    const sourceArchive = fileURLToPath(new URL(
      '../../.delivery/runtime/engineering-governance-1.0.0.tgz',
      import.meta.url,
    ))
    const runnerPath = join(root, '.delivery/runtime/engineering-governance-1.0.0.tgz')
    mkdirSync(join(runnerPath, '..'), { recursive: true })
    copyFileSync(sourceArchive, runnerPath)
    const wrapperPath = join(root, '.delivery/bin/check-delivery-policy.sh')
    mkdirSync(join(wrapperPath, '..'), { recursive: true })
    writeFileSync(wrapperPath, readRunnerArchiveFile(
      sourceArchive,
      'templates/ci/check-delivery-policy.sh',
    ))
    chmodSync(wrapperPath, 0o755)
    policy.sopVersion = '1.0.0'
    policy.sopDigest = 'a'.repeat(64)
    policy.adapters[0]!.digest = sha256(legacyBlock)
    policy.runner = {
      version: '1.0.0',
      path: '.delivery/runtime/engineering-governance-1.0.0.tgz',
      sha256: sha256(readFileSync(sourceArchive)),
    }
    writeFileSync(policyPath, stringify(policy))
    writeFileSync(join(root, '.delivery/extensions.yaml'), 'schemaVersion: 1\nextensions: []\n')

    const plan = planUnadoption(root)
    expect(applyUnadoption(plan, plan.digest).applied).toContain(realpathSync(agentsPath))
    expect(readFileSync(agentsPath, 'utf8')).toBe('')
    expect(existsSync(policyPath)).toBe(false)
  })

  it('refuses to plan removal of a drifted pinned runner or wrapper', () => {
    const runnerRoot = mkdtempSync(join(tmpdir(), 'sop-unadopt-runner-drift-'))
    temporaryDirectories.push(runnerRoot)
    const runnerAdoption = planAdoption(runnerRoot, { runnerBundlePath: testRunnerBundle() })
    applyAdoption(runnerAdoption, runnerAdoption.digest)
    const runnerPath = join(
      runnerRoot,
      `.delivery/runtime/engineering-governance-${governanceIdentity().version}.tgz`,
    )
    writeFileSync(runnerPath, 'drifted runner\n')
    expect(() => planUnadoption(runnerRoot)).toThrow('UNADOPTION_RUNNER_DRIFTED')

    const wrapperRoot = mkdtempSync(join(tmpdir(), 'sop-unadopt-wrapper-drift-'))
    temporaryDirectories.push(wrapperRoot)
    const wrapperAdoption = planAdoption(wrapperRoot, { runnerBundlePath: testRunnerBundle() })
    applyAdoption(wrapperAdoption, wrapperAdoption.digest)
    writeFileSync(
      join(wrapperRoot, '.delivery/bin/check-delivery-policy.sh'),
      '#!/bin/sh\nexit 0\n',
    )
    expect(() => planUnadoption(wrapperRoot)).toThrow('UNADOPTION_WRAPPER_DRIFTED')
  })
})
