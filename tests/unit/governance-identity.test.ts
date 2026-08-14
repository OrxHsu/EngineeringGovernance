import { expect, it } from 'vitest'

import { governanceIdentitySources } from '../../src/commands/adopt.js'

it('binds policy identity to executable source, schemas, templates, and canonical policy', () => {
  const paths = governanceIdentitySources().map((source) => source.path)
  expect(paths).toContain('src/cli/main.ts')
  expect(paths).toContain('src/commands/task-verify-v2.ts')
  expect(paths).toContain('schemas/task-contract.schema.json')
  expect(paths).toContain('templates/ci/check-delivery-policy.sh')
  expect(paths).toContain('CORE_INVARIANTS.md')
  expect(paths).toContain('MIGRATING_TO_2.0.md')
  expect(paths).toContain('dist/cli/main.js')
  expect(paths.some((path) => path.endsWith('.DS_Store'))).toBe(false)
})
