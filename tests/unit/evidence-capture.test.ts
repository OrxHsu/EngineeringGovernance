import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, it } from 'vitest'

import { captureLegacyCommandExecution as captureCommandExecution } from '../../src/evidence/capture.js'
import { canonicalDigest } from '../../src/model/digest.js'

it('rejects an existing receipt path before executing the command', () => {
  const directory = mkdtempSync(join(tmpdir(), 'sop-capture-existing-'))
  try {
    const outputPath = join(directory, 'receipt.json')
    const markerPath = join(directory, 'command-ran')
    writeFileSync(outputPath, 'existing receipt\n')

    expect(() => captureCommandExecution({
      schemaVersion: 1,
      runId: 'run-existing',
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

it('derives the single executed check identity from the exact command', () => {
  const directory = mkdtempSync(join(tmpdir(), 'sop-capture-derived-'))
  try {
    const outputPath = join(directory, 'receipt.json')
    const command = {
      executable: process.execPath,
      arguments: ['-e', "process.stdout.write('executed\\n')"],
      cwd: directory,
    }
    const artifact = captureCommandExecution({
      schemaVersion: 1,
      runId: 'run-derived',
      command,
      outputPath,
    } as Parameters<typeof captureCommandExecution>[0])

    expect(artifact.checks).toEqual([{
      id: `command:${canonicalDigest(command)}`,
      status: 'passed',
    }])
    expect(JSON.parse(readFileSync(outputPath, 'utf8'))).toEqual(artifact)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

it('rejects caller-supplied executed check identities', () => {
  const directory = mkdtempSync(join(tmpdir(), 'sop-capture-caller-id-'))
  try {
    expect(() => captureCommandExecution({
      schemaVersion: 1,
      runId: 'run-caller-id',
      checkIds: ['caller:claimed-pass'],
      command: {
        executable: process.execPath,
        arguments: ['-e', "process.stdout.write('executed\\n')"],
        cwd: directory,
      },
      outputPath: join(directory, 'receipt.json'),
    })).toThrow('COMMAND_EXECUTION_CHECK_IDS_CALLER_CONTROLLED')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
