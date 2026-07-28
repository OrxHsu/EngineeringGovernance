import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  applySkillPlan,
  planSkillInstall,
  verifySkillInstall,
} from '../../src/adapters/skill.js'

const temporaryDirectories: string[] = []

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'sop-skill-'))
  temporaryDirectories.push(path)
  return path
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async (path) => rm(path, {
    recursive: true,
    force: true,
  })))
})

describe('delivery-sop Skill', () => {
  it('stays operational and policy-free', async () => {
    const text = await readFile('skills/delivery-sop/SKILL.md', 'utf8')
    expect(text).toContain('sop check')
    expect(text).toContain('Read `.delivery/policy.yaml`')
    expect(text).toContain('Stop when the policy is missing')
    expect(text).not.toContain('Only services call transactions')
    expect(text).not.toContain('spawn')
  })

  it('installs only after a reviewed plan and is idempotent', async () => {
    const parent = await temporaryDirectory()
    const targetDirectory = join(parent, 'delivery-sop')
    const plan = planSkillInstall({ targetDirectory })
    expect(plan.writes.length).toBeGreaterThan(0)
    await expect(readFile(join(targetDirectory, 'SKILL.md'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    })

    expect(() => applySkillPlan(plan, 'f'.repeat(64))).toThrow('SKILL_PLAN_DIGEST_MISMATCH')
    applySkillPlan(plan, plan.digest)
    expect(verifySkillInstall({ targetDirectory })).toEqual({ valid: true, errors: [] })
    expect(planSkillInstall({ targetDirectory }).writes).toEqual([])
  })

  it('preserves unrelated directories and rejects drift in managed files', async () => {
    const parent = await temporaryDirectory()
    const unrelatedTarget = join(parent, 'unrelated')
    const { mkdir } = await import('node:fs/promises')
    await mkdir(unrelatedTarget)
    await writeFile(join(unrelatedTarget, 'private.txt'), 'keep\n')
    expect(() => planSkillInstall({ targetDirectory: unrelatedTarget })).toThrow(
      'SKILL_TARGET_UNMANAGED',
    )
    await expect(readFile(join(unrelatedTarget, 'private.txt'), 'utf8')).resolves.toBe('keep\n')

    const managedTarget = join(parent, 'managed')
    const plan = planSkillInstall({ targetDirectory: managedTarget })
    applySkillPlan(plan, plan.digest)
    await writeFile(join(managedTarget, 'SKILL.md'), 'local drift\n')
    expect(() => planSkillInstall({ targetDirectory: managedTarget })).toThrow(
      'SKILL_MANAGED_FILE_DRIFTED:SKILL.md',
    )
  })
})
