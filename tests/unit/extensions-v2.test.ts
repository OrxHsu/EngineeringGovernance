import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import { parse, stringify } from 'yaml'

import { startTask } from '../../src/commands/task-start.js'
import {
  extensionDescriptor,
  loadProjectExtensions,
} from '../../src/extensions/registry.js'

const temporaryDirectories: string[] = []

function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'sop-v2-extension-'))
  temporaryDirectories.push(root)
  execFileSync('git', ['-C', root, 'init', '-b', 'main'])
  execFileSync('git', ['-C', root, 'config', 'user.email', 'test@example.com'])
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Test'])
  writeFileSync(join(root, 'baseline.txt'), 'baseline\n')
  execFileSync('git', ['-C', root, 'add', 'baseline.txt'])
  execFileSync('git', ['-C', root, 'commit', '-m', 'baseline'])
  mkdirSync(join(root, '.delivery'), { recursive: true })
  return root
}

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('versioned project extensions', () => {
  it('loads only a registry-backed exact id, version, and digest', () => {
    const root = project()
    const descriptor = extensionDescriptor('external-source-provenance', '1.0.0')
    writeFileSync(join(root, '.delivery/extensions.yaml'), stringify({
      schemaVersion: 2,
      extensions: [{ id: descriptor.id, version: descriptor.version, digest: descriptor.digest }],
    }))
    expect(loadProjectExtensions(root)).toEqual([descriptor])

    writeFileSync(join(root, '.delivery/extensions.yaml'), stringify({
      schemaVersion: 2,
      extensions: [{ id: descriptor.id, version: descriptor.version, digest: '0'.repeat(64) }],
    }))
    expect(() => loadProjectExtensions(root)).toThrow(
      'PROJECT_EXTENSION_DIGEST_MISMATCH:external-source-provenance@1.0.0',
    )
  })

  it('freezes an exact copy allocation and raises source-assisted work to R3', () => {
    const root = project()
    const descriptor = extensionDescriptor('external-source-provenance', '1.0.0')
    const result = startTask({
      schemaVersion: 2,
      taskId: 'source-assisted-task',
      implementationOwner: 'codex',
      objective: 'Reuse one allocated source unit.',
      scope: ['src/adapter.ts'],
      nonGoals: [],
      authorityInputs: ['spec.md'],
      repositories: [{ id: 'root', path: root }],
      acceptance: [{
        id: 'AC-01',
        observation: 'The exact static gate passes.',
        positiveCases: ['allocated use'],
        negativeCases: ['unallocated use'],
        evidenceKind: 'static',
        command: { repositoryId: 'root', cwd: '.', executable: process.execPath, arguments: ['--version'] },
        observerPolicy: {
          expectedExitCode: 0,
          output: 'nonempty',
          checkoutMutation: 'forbidden',
          replay: 'not-required',
        },
      }],
      authorizationRequirements: [],
      extensionInputs: {
        'external-source-provenance@1.0.0': {
          mode: 'source-assisted',
          allocationId: 'allocation-1',
          accessMode: 'copy-exact',
          source: {
            locator: { kind: 'git', uri: 'https://example.invalid/source.git' },
            pin: { algorithm: 'git-commit', digest: 'a'.repeat(40) },
          },
          sourceUnits: [{ id: 'source-1', path: 'lib/transform.ts', symbols: ['transformTrip'] }],
          destinations: [{ repositoryId: 'root', path: 'src/adapter.ts', symbols: ['transformTrip'] }],
          independentDestinations: [],
          releaseDecisionRequired: true,
        },
      },
      openChoices: [],
      signals: { mutation: true, classificationComplete: true },
    }, { projectExtensions: [descriptor] })
    expect(result.risk).toBe('R3')
    const contract = parse(result.artifacts[0]!.content) as Record<string, unknown>
    expect(contract.extensions).toEqual([{
      id: descriptor.id,
      version: descriptor.version,
      digest: descriptor.digest,
      input: expect.objectContaining({ mode: 'source-assisted', accessMode: 'copy-exact' }),
    }])
  })
})
