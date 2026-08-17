import { describe, expect, it } from 'vitest'
import { buildProgram } from '../../src/cli/main.js'

describe('beta1 preflight CLI', () => {
  it('returns structured failure for the incomplete historical input without mutation', async () => {
    let output = ''
    await buildProgram({ write: (text) => { output += text } }).parseAsync([
      'node', 'sop', 'task', 'preflight', '--project', process.cwd(),
      '--input', `${process.cwd()}/.delivery/inputs/global-sop-2-1-beta-1-fix-1-repair-3.yaml`,
    ])
    const result = JSON.parse(output) as { valid: boolean; errors: string[] }
    expect(result.valid).toBe(false)
    expect(result.errors).toContain('PREFLIGHT_INPUT_SCHEMA_INVALID')
    expect(output).not.toContain('TypeError')
  })
})
