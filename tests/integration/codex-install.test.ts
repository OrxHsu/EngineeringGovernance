import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  applyCodexPlan,
  planCodexInstall,
  planCodexRemoval,
  verifyCodexInstall,
} from '../../src/adapters/codex.js'

const identity = { version: '1.0.0', digest: 'a'.repeat(64) }
const temporaryDirectories: string[] = []

async function temporaryHome(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'sop-codex-home-'))
  temporaryDirectories.push(path)
  return path
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async (path) => rm(path, {
    recursive: true,
    force: true,
  })))
})

describe('Codex global adapter', () => {
  it('preserves existing instructions, installs once, and detects drift', async () => {
    const homeDirectory = await temporaryHome()
    const agentsPath = join(homeDirectory, '.codex', 'AGENTS.md')
    await writeFile(agentsPath, '# Existing instructions\n\nKeep this byte-for-byte.\n', {
      flag: 'wx',
    }).catch(async (error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
      const { mkdir } = await import('node:fs/promises')
      await mkdir(join(homeDirectory, '.codex'), { recursive: true })
      await writeFile(agentsPath, '# Existing instructions\n\nKeep this byte-for-byte.\n')
    })

    const plan = planCodexInstall({
      homeDirectory,
      identity,
      ccSwitchSettingNames: ['common_config_codex'],
    })
    expect(plan.writes).toHaveLength(1)
    expect(await readFile(agentsPath, 'utf8')).toBe('# Existing instructions\n\nKeep this byte-for-byte.\n')

    applyCodexPlan(plan, plan.digest)
    const installed = await readFile(agentsPath, 'utf8')
    expect(installed.match(/engineering-governance:start/gu)).toHaveLength(1)
    expect(installed).toContain('~/.codex/bin/sop')
    expect(installed.endsWith('# Existing instructions\n\nKeep this byte-for-byte.\n')).toBe(true)
    expect(verifyCodexInstall({ homeDirectory, identity })).toEqual({ valid: true, errors: [] })

    const second = planCodexInstall({ homeDirectory, identity, ccSwitchSettingNames: [] })
    expect(second.writes).toEqual([])
    expect(second.digest).toBe(planCodexInstall({
      homeDirectory,
      identity,
      ccSwitchSettingNames: [],
    }).digest)

    await writeFile(agentsPath, installed.replace(identity.digest, 'b'.repeat(64)))
    expect(verifyCodexInstall({ homeDirectory, identity }).errors).toContain('CODEX_ADAPTER_DRIFTED')
  })

  it('refuses manager ownership and removal with an unknown digest', async () => {
    const homeDirectory = await temporaryHome()
    expect(() => planCodexInstall({
      homeDirectory,
      identity,
      ccSwitchSettingNames: ['codex_agents_content'],
    })).toThrow('CODEX_AGENTS_MANAGER_OWNED:codex_agents_content')

    const plan = planCodexInstall({ homeDirectory, identity, ccSwitchSettingNames: [] })
    applyCodexPlan(plan, plan.digest)
    expect(() => planCodexRemoval({
      homeDirectory,
      expectedDigest: 'b'.repeat(64),
    })).toThrow('CODEX_ADAPTER_DIGEST_MISMATCH')

    const removal = planCodexRemoval({ homeDirectory, expectedDigest: identity.digest })
    applyCodexPlan(removal, removal.digest)
    await expect(readFile(join(homeDirectory, '.codex', 'AGENTS.md'), 'utf8')).resolves.toBe('')
  })
})
