import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { verifyExternalSourceArtifacts } from '../../src/extensions/external-source.js'
import { extensionDescriptor } from '../../src/extensions/registry.js'

const temporaryDirectories: string[] = []
const descriptor = extensionDescriptor('external-source-provenance', '1.0.0')

type MutableDocument = Record<string, any>

interface FixtureState {
  allocation: MutableDocument
  changedPaths: Array<{ repositoryId: string; path: string }>
  ledgerCopies: Record<string, number>
  omitKinds: string[]
  references: Array<{ extensionId: string; kind: string; path: string; sha256: string }>
  release: MutableDocument
  root: string
  taskDirectory: string
  use: MutableDocument
}

function sha256(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex')
}

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

function state(): FixtureState {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'sop-external-source-adversarial-')))
  temporaryDirectories.push(root)
  const taskDirectory = join(root, '.delivery/tasks/provenance-adversarial')
  const extension = { id: descriptor.id, version: descriptor.version, digest: descriptor.digest }
  return {
    root,
    taskDirectory,
    omitKinds: [],
    references: [],
    ledgerCopies: {},
    changedPaths: [
      { repositoryId: 'root', path: 'src/a.ts' },
      { repositoryId: 'root', path: 'src/b.ts' },
    ],
    allocation: {
      mode: 'source-assisted',
      allocationId: 'allocation-1',
      accessMode: 'copy-exact',
      source: {
        locator: { kind: 'git', uri: 'https://example.invalid/synthetic-source.git' },
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
    },
    use: {
      schemaVersion: 1,
      artifactType: 'external-source-use',
      extension,
      taskId: 'provenance-adversarial',
      contractDigest: 'c'.repeat(64),
      allocationId: 'allocation-1',
      sourceUses: [
        { sourceUnitId: 'source-a', use: 'copy-exact' },
        { sourceUnitId: 'source-b', use: 'copy-exact' },
      ],
      destinationUses: [
        {
          repositoryId: 'root',
          path: 'src/a.ts',
          symbols: ['a'],
          sourceUnitIds: ['source-a'],
          use: 'copy-exact',
        },
        {
          repositoryId: 'root',
          path: 'src/b.ts',
          symbols: ['b'],
          sourceUnitIds: ['source-b'],
          use: 'copy-exact',
        },
      ],
    },
    release: {
      schemaVersion: 1,
      artifactType: 'external-source-release',
      extension,
      taskId: 'provenance-adversarial',
      contractDigest: 'c'.repeat(64),
      allocationId: 'allocation-1',
      decision: 'approved',
      decidedBy: { id: 'release-reviewer', trustLevel: 'local-claim' },
      destinationIds: ['root:src/a.ts', 'root:src/b.ts'],
      dispositionId: 'synthetic-reviewed-route',
      basis: 'Synthetic local fixture only.',
    },
  }
}

function verify(current: FixtureState): string[] {
  const documents = new Map([
    ['external-source-use', current.use],
    ['external-source-release', current.release],
  ])
  const references: FixtureState['references'] = []
  for (const [kind, document] of documents) {
    if (current.omitKinds.includes(kind)) continue
    const path = join(current.taskDirectory, 'extensions', descriptor.id, `${kind}.json`)
    const content = `${JSON.stringify(document, null, 2)}\n`
    write(path, content)
    references.push({ extensionId: descriptor.id, kind, path, sha256: sha256(content) })
  }
  references.push(...current.references)
  const artifactRefs = references.flatMap((reference) => Array.from(
    { length: current.ledgerCopies[reference.kind] ?? 1 },
    () => ({
      kind: `extension:${descriptor.id}:${reference.kind}`,
      path: relative(current.root, reference.path),
      sha256: reference.sha256,
    }),
  ))
  return verifyExternalSourceArtifacts({
    binding: {
      id: descriptor.id,
      version: descriptor.version,
      digest: descriptor.digest,
      input: current.allocation,
    },
    references,
    projectRoot: current.root,
    taskDirectory: current.taskDirectory,
    taskId: 'provenance-adversarial',
    contractDigest: 'c'.repeat(64),
    ledgerEvents: [{ artifactRefs }] as never,
    changedPaths: current.changedPaths,
  }).errors
}

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('external-source provenance adversarial integrity', () => {
  it('accepts the complete ordered synthetic allocation/use/release set', () => {
    expect(verify(state())).toEqual([])
  })

  it('rejects omitted allocation, use, and release records', () => {
    const omittedAllocation = state()
    omittedAllocation.allocation = { mode: 'source-assisted' }
    expect(verify(omittedAllocation)).toContain('EXTERNAL_SOURCE_INPUT_INVALID')

    const omittedUse = state()
    omittedUse.omitKinds.push('external-source-use')
    expect(verify(omittedUse)).toContain('EXTERNAL_SOURCE_ARTIFACT_SET_MISMATCH')

    const omittedRelease = state()
    omittedRelease.omitKinds.push('external-source-release')
    expect(verify(omittedRelease)).toContain('EXTERNAL_SOURCE_ARTIFACT_SET_MISMATCH')
  })

  it('rejects an empty allocation record with a machine-readable error', () => {
    const emptyAllocation = state()
    emptyAllocation.allocation.allocationId = ''
    expect(verify(emptyAllocation)).toContain('EXTERNAL_SOURCE_ALLOCATION_ID_REQUIRED')
  })

  it('rejects an empty use record with a machine-readable error', () => {
    const emptyUse = state()
    emptyUse.use = {}
    expect(verify(emptyUse)).toContain('EXTERNAL_SOURCE_USE_SCHEMA_INVALID')
  })

  it('rejects an empty release record with a machine-readable error', () => {
    const emptyRelease = state()
    emptyRelease.release = {}
    expect(verify(emptyRelease)).toContain('EXTERNAL_SOURCE_RELEASE_SCHEMA_INVALID')
  })

  it('rejects duplicated allocation, use, release, and ledger records', () => {
    const duplicatedAllocation = state()
    duplicatedAllocation.allocation.sourceUnits.push(
      structuredClone(duplicatedAllocation.allocation.sourceUnits[0]),
    )
    expect(verify(duplicatedAllocation)).toContain('EXTERNAL_SOURCE_UNIT_INVALID')

    const duplicatedUse = state()
    duplicatedUse.use.sourceUses.push(structuredClone(duplicatedUse.use.sourceUses[0]))
    expect(verify(duplicatedUse)).toContain('EXTERNAL_SOURCE_USE_IDS_DUPLICATED')

    const duplicatedRelease = state()
    duplicatedRelease.release.destinationIds.push(duplicatedRelease.release.destinationIds[0])
    expect(verify(duplicatedRelease)).toContain('EXTERNAL_SOURCE_RELEASE_SCHEMA_INVALID')

    const duplicatedLedger = state()
    duplicatedLedger.ledgerCopies['external-source-use'] = 2
    expect(verify(duplicatedLedger)).toContain('EXTERNAL_SOURCE_LEDGER_REF_INVALID:external-source-use:2')
  })

  it('rejects reordered allocation/use/release records', () => {
    const reordered = state()
    reordered.allocation.sourceUnits.reverse()
    reordered.allocation.destinations.reverse()
    reordered.use.sourceUses.reverse()
    reordered.use.destinationUses.reverse()
    reordered.release.destinationIds.reverse()
    expect(verify(reordered)).toContain('EXTERNAL_SOURCE_RECORD_ORDER_MISMATCH')
  })

  it('rejects stale and forged use/release provenance', () => {
    const stale = state()
    stale.use.contractDigest = 'd'.repeat(64)
    stale.release.contractDigest = 'd'.repeat(64)
    expect(verify(stale)).toContain('EXTERNAL_SOURCE_CONTRACT_MISMATCH')

    const forged = state()
    forged.use.extension.digest = 'f'.repeat(64)
    forged.release.extension.digest = 'f'.repeat(64)
    expect(verify(forged)).toContain('EXTERNAL_SOURCE_EXTENSION_IDENTITY_MISMATCH')
  })

  it('rejects partially populated actual-use records', () => {
    const partial = state()
    partial.use.sourceUses.pop()
    partial.use.destinationUses[1].sourceUnitIds = ['source-a']
    expect(verify(partial)).toContain('EXTERNAL_SOURCE_USE_SET_MISMATCH')
  })

  it('rejects a partially populated allocation record', () => {
    const partialAllocation = state()
    delete partialAllocation.allocation.destinations
    expect(verify(partialAllocation)).toContain('EXTERNAL_SOURCE_INPUT_INVALID')
  })

  it('rejects a partially populated release record', () => {
    const partialRelease = state()
    delete partialRelease.release.basis
    expect(verify(partialRelease)).toContain('EXTERNAL_SOURCE_RELEASE_SCHEMA_INVALID')
  })

  it('rejects unpinned sources and unallocated destinations', () => {
    const unpinned = state()
    unpinned.allocation.source.pin.digest = ''
    expect(verify(unpinned)).toContain('EXTERNAL_SOURCE_PIN_INVALID')

    const unallocated = state()
    unallocated.use.destinationUses[1].path = 'src/unallocated.ts'
    expect(verify(unallocated)).toContain('EXTERNAL_SOURCE_DESTINATION_USE_MISMATCH')
  })

  it('rejects hidden changed destinations', () => {
    const hidden = state()
    hidden.changedPaths.push({ repositoryId: 'root', path: 'src/hidden.ts' })
    expect(verify(hidden)).toContain('EXTERNAL_SOURCE_CHANGED_PATH_CLASSIFICATION_MISMATCH')
  })

  it('rejects unresolved or blocked release classification', () => {
    const unresolved = state()
    unresolved.release.destinationIds.pop()
    expect(verify(unresolved)).toContain('EXTERNAL_SOURCE_RELEASE_SCOPE_MISMATCH')

    const blocked = state()
    blocked.release.decision = 'blocked'
    expect(verify(blocked)).toContain('EXTERNAL_SOURCE_RELEASE_BLOCKED')
  })
})
