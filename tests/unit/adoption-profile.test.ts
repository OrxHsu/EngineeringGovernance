import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, expect, it } from 'vitest'

import { adoptionProfile } from '../../src/project/adoption-profile.js'

const temporaryDirectories: string[] = []

function directory(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix))
  temporaryDirectories.push(path)
  return path
}

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true })
})

it('uses stable project identities for governance and NoMe', () => {
  const governance = directory('EngineeringGovernance-')
  writeFileSync(join(governance, 'CORE_INVARIANTS.md'), '')
  writeFileSync(join(governance, 'DEVELOPMENT_SOP.md'), '')
  writeFileSync(join(governance, 'RISK_CLASSIFICATION.md'), '')
  writeFileSync(join(governance, 'VERSION'), '1.0.0\n')
  expect(adoptionProfile(governance).projectId).toBe('engineering-governance')

  const noMe = directory('NoMe_V2-')
  mkdirSync(join(noMe, 'Docs'))
  writeFileSync(join(noMe, 'Docs', 'ODD.md'), '')
  writeFileSync(join(noMe, 'project.yml'), '')
  writeFileSync(join(noMe, 'AGENTS.md'), '')
  expect(adoptionProfile(noMe)).toMatchObject({
    projectId: 'nome-v2',
    adapters: [{ source: 'AGENTS.md', targets: ['AGENTS.md'] }],
  })
})
