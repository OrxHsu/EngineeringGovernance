import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  externalSourceMinimumRisk,
  externalSourceExtensionId,
  externalSourceExtensionVersion,
  verifyExternalSourceArtifacts,
  validateExternalSourceTaskInput,
} from '../../src/extensions/external-source.js'
import { extensionDescriptor } from '../../src/extensions/registry.js'

const descriptor = extensionDescriptor(externalSourceExtensionId, externalSourceExtensionVersion)
const roots: string[] = []

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

function sourceFixture(): any {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'sop-external-unit-')))
  roots.push(root)
  const taskId = 'external-unit-task'
  const taskDirectory = join(root, '.delivery', 'tasks', taskId)
  const extension = { id: descriptor.id, version: descriptor.version, digest: descriptor.digest }
  const input = {
    mode: 'source-assisted',
    allocationId: 'allocation-1',
    accessMode: 'copy-exact',
    source: {
      locator: { kind: 'git', uri: 'https://example.invalid/source.git' },
      pin: { algorithm: 'git-commit', digest: 'a'.repeat(40) },
    },
    sourceUnits: [
      { id: 'source-a', path: 'lib/a.ts', symbols: ['a'] },
      { id: 'source-b', path: 'lib/b.ts', symbols: ['b'] },
    ],
    destinations: [
      { repositoryId: 'root', path: 'src/a.ts', symbols: ['a'] },
      { repositoryId: 'root', path: 'src/b.ts', symbols: ['b'] },
    ],
    independentDestinations: [],
    releaseDecisionRequired: true,
  }
  const use = {
    schemaVersion: 1,
    artifactType: 'external-source-use',
    extension,
    taskId,
    contractDigest: 'c'.repeat(64),
    allocationId: 'allocation-1',
    sourceUses: [
      { sourceUnitId: 'source-a', use: 'copy-exact' },
      { sourceUnitId: 'source-b', use: 'copy-exact' },
    ],
    destinationUses: [
      { repositoryId: 'root', path: 'src/a.ts', symbols: ['a'], sourceUnitIds: ['source-a'], use: 'copy-exact' },
      { repositoryId: 'root', path: 'src/b.ts', symbols: ['b'], sourceUnitIds: ['source-b'], use: 'copy-exact' },
    ],
  }
  const release = {
    schemaVersion: 1,
    artifactType: 'external-source-release',
    extension,
    taskId,
    contractDigest: 'c'.repeat(64),
    allocationId: 'allocation-1',
    decision: 'approved',
    decidedBy: { id: 'user', trustLevel: 'local-claim' },
    destinationIds: ['root:src/a.ts', 'root:src/b.ts'],
    dispositionId: 'release-1',
    basis: 'unit fixture',
  }
  const usePath = join(taskDirectory, 'extensions', externalSourceExtensionId, 'external-source-use.json')
  const releasePath = join(taskDirectory, 'extensions', externalSourceExtensionId, 'external-source-release.json')
  mkdirSync(join(usePath, '..'), { recursive: true })
  writeFileSync(usePath, `${JSON.stringify(use, null, 2)}\n`)
  writeFileSync(releasePath, `${JSON.stringify(release, null, 2)}\n`)
  const references = [
    { extensionId: externalSourceExtensionId, kind: 'external-source-use', path: usePath, sha256: sha256(readFileSync(usePath)) },
    { extensionId: externalSourceExtensionId, kind: 'external-source-release', path: releasePath, sha256: sha256(readFileSync(releasePath)) },
  ]
  const ledgerEvents = [{ artifactRefs: references.map((reference) => ({
    kind: `extension:${externalSourceExtensionId}:${reference.kind}`,
    path: reference.path.replace(`${root}/`, ''),
    sha256: reference.sha256,
  })) }]
  return { root, taskId, taskDirectory, input, references, ledgerEvents, usePath, releasePath }
}

function verify(state: any, references = state.references): any {
  return verifyExternalSourceArtifacts({
    binding: { id: descriptor.id, version: descriptor.version, digest: descriptor.digest, input: state.input },
    references,
    projectRoot: state.root,
    taskDirectory: state.taskDirectory,
    taskId: state.taskId,
    contractDigest: 'c'.repeat(64),
    ledgerEvents: state.ledgerEvents,
    changedPaths: [
      { repositoryId: 'root', path: 'src/a.ts' },
      { repositoryId: 'root', path: 'src/b.ts' },
    ],
  })
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('external-source contract boundary', () => {
  it('keeps independent mode default-deny and below R3', () => {
    const input = validateExternalSourceTaskInput({ mode: 'independent' })
    expect(input).toEqual({ mode: 'independent' })
    expect(externalSourceMinimumRisk(input)).toBeUndefined()
  })

  it('rejects extra fields and incomplete source-assisted allocations', () => {
    expect(() => validateExternalSourceTaskInput({ mode: 'independent', source: 'forged' }))
      .toThrow('EXTERNAL_SOURCE_INDEPENDENT_INPUT_NOT_EMPTY')
    expect(() => validateExternalSourceTaskInput({ mode: 'source-assisted' }))
      .toThrow('EXTERNAL_SOURCE_INPUT_INVALID')
  })

  it('accepts the exact source-assisted allocation and rejects missing or duplicate artifacts', () => {
    const state = sourceFixture()
    expect(verify(state).errors).toEqual([])
    expect(verify(state, state.references.slice(0, 1)).errors).toContain('EXTERNAL_SOURCE_ARTIFACT_SET_MISMATCH')
    expect(verify(state, [...state.references, state.references[1]]).errors)
      .toContain('EXTERNAL_SOURCE_ARTIFACT_SET_MISMATCH')
  })

  it('rejects reordered, stale, forged, and out-of-allocation records', () => {
    const reordered = sourceFixture()
    const use = JSON.parse(readFileSync(reordered.usePath, 'utf8'))
    use.sourceUses.reverse()
    writeFileSync(reordered.usePath, `${JSON.stringify(use, null, 2)}\n`)
    const reorderedRefs = [{ ...reordered.references[0], sha256: sha256(readFileSync(reordered.usePath)) }, reordered.references[1]]
    expect(verify(reordered, reorderedRefs).errors).toContain('EXTERNAL_SOURCE_RECORD_ORDER_MISMATCH')

    const stale = sourceFixture()
    expect(verify(stale, [{ ...stale.references[0], sha256: '0'.repeat(64) }, stale.references[1]]).errors)
      .toContain('EXTERNAL_SOURCE_ARTIFACT_DIGEST_MISMATCH:external-source-use')

    const forged = sourceFixture()
    const forgedUse = JSON.parse(readFileSync(forged.usePath, 'utf8'))
    forgedUse.destinationUses[0].sourceUnitIds = ['forged-source']
    writeFileSync(forged.usePath, `${JSON.stringify(forgedUse, null, 2)}\n`)
    const forgedRefs = [{ ...forged.references[0], sha256: sha256(readFileSync(forged.usePath)) }, forged.references[1]]
    expect(verify(forged, forgedRefs).errors).toContain('EXTERNAL_SOURCE_DESTINATION_UNALLOCATED:root:src/a.ts')

    const outside = sourceFixture()
    const outsideUse = JSON.parse(readFileSync(outside.usePath, 'utf8'))
    outsideUse.destinationUses[0].path = 'src/outside.ts'
    writeFileSync(outside.usePath, `${JSON.stringify(outsideUse, null, 2)}\n`)
    const outsideRefs = [{ ...outside.references[0], sha256: sha256(readFileSync(outside.usePath)) }, outside.references[1]]
    expect(verify(outside, outsideRefs).errors).toContain('EXTERNAL_SOURCE_DESTINATION_USE_MISMATCH')
  })
})
