import { readFileSync } from 'node:fs'

import { expect, it } from 'vitest'

import { governanceIdentity } from '../../src/commands/adopt.js'

it('keeps package, canonical documents, and governance identity on one release version', () => {
  const packageDocument = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }
  const version = readFileSync('VERSION', 'utf8').trim()
  expect(version).toBe('2.1.0-beta.0')
  expect(version).toBe(packageDocument.version)
  expect(governanceIdentity().version).toBe(version)
  for (const path of ['CORE_INVARIANTS.md', 'DEVELOPMENT_SOP.md', 'RISK_CLASSIFICATION.md']) {
    expect(readFileSync(path, 'utf8')).toContain(`Version: ${version}`)
  }

  expect(readFileSync('README.md', 'utf8')).toContain('local `2.0.0` release candidate')
  expect(readFileSync('README.md', 'utf8')).toContain('MIGRATING_TO_2.0.md')
  expect(readFileSync('MIGRATING_TO_2.0.md', 'utf8')).toContain('legacy inspect-only')
  expect(readFileSync('templates/project-extensions.yaml', 'utf8')).toContain('schemaVersion: 2')
  expect(readFileSync('templates/project-policy.yaml', 'utf8')).toContain('sopVersion: 2.0.0')
  expect(readFileSync('templates/task-contract.yaml', 'utf8')).toContain('schemaVersion: 2')
  expect(readFileSync('templates/task-contract.yaml', 'utf8')).toContain('sopVersion: 2.0.0')
  expect(readFileSync('skills/delivery-sop/SKILL.md', 'utf8')).toContain('legacy inspect-only')
})
