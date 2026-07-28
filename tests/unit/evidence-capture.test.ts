import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, it } from 'vitest'

import { captureCommandExecution } from '../../src/evidence/capture.js'

it('rejects an existing receipt path before executing the command', () => {
  const directory = mkdtempSync(join(tmpdir(), 'sop-capture-existing-'))
  try {
    const outputPath = join(directory, 'receipt.json')
    const markerPath = join(directory, 'command-ran')
    writeFileSync(outputPath, 'existing receipt\n')

    expect(() => captureCommandExecution({
      schemaVersion: 1,
      runId: 'run-existing',
      checkIds: ['check:existing'],
      command: {
        executable: process.execPath,
        arguments: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(markerPath)}, 'ran')`],
        cwd: directory,
      },
      outputPath,
    })).toThrow('COMMAND_EXECUTION_OUTPUT_EXISTS')
    expect(existsSync(markerPath)).toBe(false)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
