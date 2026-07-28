import { readFileSync } from 'node:fs'

import { expect, it } from 'vitest'

import { governanceIdentity } from '../../src/commands/adopt.js'

it('keeps package, canonical documents, and governance identity on one release version', () => {
  const packageDocument = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }
  const version = readFileSync('VERSION', 'utf8').trim()
  expect(version).toBe(packageDocument.version)
  expect(governanceIdentity().version).toBe(version)
  for (const path of ['CORE_INVARIANTS.md', 'DEVELOPMENT_SOP.md', 'RISK_CLASSIFICATION.md']) {
    expect(readFileSync(path, 'utf8')).toContain(`Version: ${version}`)
  }
})
