import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import { parse, stringify } from 'yaml'

import { startTask } from '../../src/commands/task-start.js'
import { canonicalDigest } from '../../src/model/digest.js'
import { loadLegacyCompatibilityManifest, verifyLegacyTaskCompatibility } from '../../src/project/legacy-compatibility.js'
import { validateProjectTaskGraph } from '../../src/project/task-graph.js'

const roots: string[] = []
function sha256(input: string | Uint8Array): string {
  return createHash('sha256').update(input).digest('hex')
}

function createRunnerArchive(root: string, version: string, filename: string): string {
  const stage = join(root, `.runner-stage-${version}`)
  const packageRoot = join(stage, 'package')
  mkdirSync(packageRoot, { recursive: true })
  writeFileSync(join(packageRoot, 'package.json'), `${JSON.stringify({
    name: '@xgh/engineering-governance',
    version,
  })}\n`)
  writeFileSync(join(packageRoot, 'VERSION'), `${version}\n`)
  const archive = join(root, '.delivery/runtime', filename)
  mkdirSync(join(archive, '..'), { recursive: true })
  execFileSync('/usr/bin/tar', ['-czf', archive, '-C', stage, 'package'])
  return archive
}

function files(root: string): Array<{ path: string; sha256: string }> {
  const result: Array<{ path: string; sha256: string }> = []
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1)) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) visit(path)
      else result.push({ path: relative(root, path), sha256: sha256(readFileSync(path)) })
    }
  }
  visit(root)
  return result
}

function fixture(): { root: string; taskId: string; manifestPath: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'sop-legacy-compat-')))
  roots.push(root)
  execFileSync('git', ['-C', root, 'init', '-b', 'main'])
  execFileSync('git', ['-C', root, 'config', 'user.email', 'test@example.com'])
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Test'])
  writeFileSync(join(root, 'spec.md'), 'historical authority\n')
  execFileSync('git', ['-C', root, 'add', 'spec.md'])
  execFileSync('git', ['-C', root, 'commit', '-m', 'baseline'])
  const taskId = 'historical-beta3'
  const started = startTask({
    schemaVersion: 2,
    taskId,
    implementationOwner: 'codex',
    objective: 'Preserve a historical schema-v2 task.',
    scope: ['src/**'],
    nonGoals: [],
    authorityInputs: ['spec.md'],
    repositories: [{ id: 'root', path: root }],
    acceptance: [{
      id: 'AC-01',
      observation: 'The historical contract remains inspectable.',
      positiveCases: ['valid snapshot'],
      negativeCases: ['forged snapshot'],
      evidenceKind: 'unit',
      command: { repositoryId: 'root', cwd: '.', executable: process.execPath, arguments: ['--version'] },
      observerPolicy: {
        expectedExitCode: 0,
        output: 'nonempty',
        checkoutMutation: 'forbidden',
        replay: 'not-required',
      },
    }],
    authorizationRequirements: [],
    openChoices: [],
    signals: { localEdit: true },
  })
  for (const artifact of started.artifacts) {
    const path = join(root, artifact.path)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, artifact.content)
  }
  const taskRoot = join(root, '.delivery/tasks', taskId)
  writeFileSync(join(taskRoot, 'CURSOR_PROMPT.md'), 'mixed-case inventory path\n')
  mkdirSync(join(taskRoot, 'nested'), { recursive: true })
  writeFileSync(join(taskRoot, 'nested/lowercase.txt'), 'nested inventory path\n')
  const contractPath = join(taskRoot, 'contract.yaml')
  const contract = parse(readFileSync(contractPath, 'utf8')) as Record<string, unknown>
  contract.sopVersion = '2.1.0-beta.3'
  contract.policyDigest = 'a'.repeat(64)
  delete contract.contractDigest
  contract.contractDigest = canonicalDigest(contract)
  writeFileSync(contractPath, stringify(contract))
  const ledgerPath = join(taskRoot, 'ledger.jsonl')
  const event = JSON.parse(readFileSync(ledgerPath, 'utf8')) as Record<string, unknown>
  event.contractDigest = contract.contractDigest
  const artifactRefs = event.artifactRefs as Array<Record<string, unknown>>
  artifactRefs[0]!.sha256 = sha256(readFileSync(contractPath))
  const { eventDigest: _oldDigest, ...unsignedEvent } = event
  event.eventDigest = canonicalDigest(unsignedEvent)
  writeFileSync(ledgerPath, `${JSON.stringify(event)}\n`)

  const runtimePath = '.delivery/runtime/engineering-governance-2.1.0-beta.3.tgz'
  createRunnerArchive(root, '2.1.0-beta.3', 'engineering-governance-2.1.0-beta.3.tgz')
  const manifestPath = '.delivery/compatibility/beta0-beta3-schema-v2-history.yaml'
  const manifestAbsolute = join(root, manifestPath)
  const entry = {
    taskId,
    classification: 'beta0-beta3-history',
    reason: 'fixture historical beta3 task',
    source: {
      sopVersion: '2.1.0-beta.3',
      policyDigest: 'a'.repeat(64),
      runner: {
        version: '2.1.0-beta.3',
        path: runtimePath,
        sha256: sha256(readFileSync(join(root, runtimePath))),
      },
    },
    contract: { rawSha256: sha256(readFileSync(contractPath)), digest: contract.contractDigest },
    ledger: {
      rawSha256: sha256(readFileSync(ledgerPath)),
      finalState: 'DEFINED',
      finalEventDigest: event.eventDigest,
    },
    files: files(taskRoot),
  }
  const unsignedManifest = {
    schemaVersion: 1,
    artifactType: 'engineering-governance-legacy-task-compatibility-v1',
    projectId: 'fixture-project',
    entries: [entry],
  }
  const manifest = { ...unsignedManifest, manifestDigest: canonicalDigest(unsignedManifest) }
  mkdirSync(join(manifestAbsolute, '..'), { recursive: true })
  writeFileSync(manifestAbsolute, stringify(manifest))
  const policy = {
    schemaVersion: 1,
    sopVersion: '2.1.0',
    sopDigest: 'b'.repeat(64),
    projectId: 'fixture-project',
    adapters: [],
    artifactMapping: {
      'taskGraph.legacySchemaV2ManifestPath': manifestPath,
      'taskGraph.legacySchemaV2ManifestSha256': sha256(readFileSync(manifestAbsolute)),
    },
  }
  mkdirSync(join(root, '.delivery'), { recursive: true })
  writeFileSync(join(root, '.delivery/policy.yaml'), stringify(policy))
  return { root, taskId, manifestPath }
}

function rewriteManifest(
  root: string,
  manifestPath: string,
  mutate: (manifest: Record<string, any>) => void,
): void {
  const absolute = join(root, manifestPath)
  const manifest = parse(readFileSync(absolute, 'utf8')) as Record<string, any>
  mutate(manifest)
  delete manifest.manifestDigest
  manifest.manifestDigest = canonicalDigest(manifest)
  writeFileSync(absolute, stringify(manifest))
  const policyPath = join(root, '.delivery/policy.yaml')
  const policy = parse(readFileSync(policyPath, 'utf8')) as Record<string, any>
  policy.artifactMapping['taskGraph.legacySchemaV2ManifestSha256'] = sha256(readFileSync(absolute))
  writeFileSync(policyPath, stringify(policy))
}

function writeLedgerAndRefresh(
  result: ReturnType<typeof fixture>,
  events: Array<Record<string, any>>,
): void {
  const taskRoot = join(result.root, '.delivery/tasks', result.taskId)
  const ledgerPath = join(taskRoot, 'ledger.jsonl')
  writeFileSync(ledgerPath, `${events.map((event) => JSON.stringify(event)).join('\n')}\n`)
  rewriteManifest(result.root, result.manifestPath, (manifest) => {
    const entry = manifest.entries[0]
    entry.ledger.rawSha256 = sha256(readFileSync(ledgerPath))
    entry.ledger.finalState = events.at(-1)!.to
    entry.ledger.finalEventDigest = events.at(-1)!.eventDigest
    entry.files = files(taskRoot)
  })
}

function appendValidLegacyEvent(result: ReturnType<typeof fixture>): Array<Record<string, any>> {
  const taskRoot = join(result.root, '.delivery/tasks', result.taskId)
  const contractPath = join(taskRoot, 'contract.yaml')
  const contract = parse(readFileSync(contractPath, 'utf8')) as Record<string, any>
  const first = JSON.parse(readFileSync(join(taskRoot, 'ledger.jsonl'), 'utf8')) as Record<string, any>
  const second: Record<string, any> = {
    schemaVersion: 2,
    sequence: 2,
    previousEventDigest: first.eventDigest,
    from: 'DEFINED',
    to: 'IN_PROGRESS',
    actorId: 'codex',
    contractDigest: contract.contractDigest,
    artifactRefs: [{
      kind: 'contract',
      path: `.delivery/tasks/${result.taskId}/contract.yaml`,
      sha256: sha256(readFileSync(contractPath)),
    }],
  }
  second.eventDigest = canonicalDigest(second)
  const events = [first, second]
  writeLedgerAndRefresh(result, events)
  return events
}

function supersededFixture(): ReturnType<typeof fixture> {
  const result = fixture()
  const taskRoot = join(result.root, '.delivery/tasks', result.taskId)
  const contractPath = join(taskRoot, 'contract.yaml')
  const ledgerPath = join(taskRoot, 'ledger.jsonl')
  const reviewPath = join(taskRoot, 'contract-review.yaml')
  const contract = parse(readFileSync(contractPath, 'utf8')) as Record<string, any>
  contract.sopVersion = '2.1.0'
  contract.policyDigest = 'b'.repeat(64)
  delete contract.contractDigest
  contract.contractDigest = canonicalDigest(contract)
  writeFileSync(contractPath, stringify(contract))
  const event = JSON.parse(readFileSync(ledgerPath, 'utf8')) as Record<string, any>
  event.contractDigest = contract.contractDigest
  event.artifactRefs[0].sha256 = sha256(readFileSync(contractPath))
  delete event.eventDigest
  event.eventDigest = canonicalDigest(event)
  writeFileSync(ledgerPath, `${JSON.stringify(event)}\n`)
  writeFileSync(reviewPath, stringify({ decision: 'REPAIR_REQUIRED', findings: [{ id: 'CR-001' }] }))

  const successorId = 'successor-task'
  const successorRoot = join(result.root, '.delivery/tasks', successorId)
  mkdirSync(successorRoot, { recursive: true })
  const successor = {
    ...contract,
    taskId: successorId,
    predecessors: [{
      taskId: result.taskId,
      contractPath: `.delivery/tasks/${result.taskId}/contract.yaml`,
      contractRawSha256: sha256(readFileSync(contractPath)),
      contractDigest: contract.contractDigest,
      reviewPath: `.delivery/tasks/${result.taskId}/contract-review.yaml`,
      reviewRawSha256: sha256(readFileSync(reviewPath)),
      decision: 'REPAIR_REQUIRED',
      findingIds: ['CR-001'],
    }],
  }
  delete successor.contractDigest
  successor.contractDigest = canonicalDigest(successor)
  const successorPath = join(successorRoot, 'contract.yaml')
  writeFileSync(successorPath, stringify(successor))

  const runtimePath = '.delivery/runtime/engineering-governance-2.1.0.tgz'
  createRunnerArchive(result.root, '2.1.0', 'engineering-governance-2.1.0.tgz')
  rewriteManifest(result.root, result.manifestPath, (manifest) => {
    const entry = manifest.entries[0]
    entry.classification = 'superseded-readiness-history'
    entry.source = {
      sopVersion: '2.1.0',
      policyDigest: 'b'.repeat(64),
      runner: { version: '2.1.0', path: runtimePath, sha256: sha256(readFileSync(join(result.root, runtimePath))) },
    }
    entry.contract = { rawSha256: sha256(readFileSync(contractPath)), digest: contract.contractDigest }
    entry.ledger = {
      rawSha256: sha256(readFileSync(ledgerPath)),
      finalState: 'DEFINED',
      finalEventDigest: event.eventDigest,
    }
    entry.successor = {
      taskId: successorId,
      contractRawSha256: sha256(readFileSync(successorPath)),
      contractDigest: successor.contractDigest,
      reviewRawSha256: sha256(readFileSync(reviewPath)),
      decision: 'REPAIR_REQUIRED',
      findingIds: ['CR-001'],
    }
    entry.files = files(taskRoot)
  })
  return result
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('schema-v2 historical compatibility', () => {
  it('reports an exact beta3 snapshot as inspect-only', () => {
    const { root, taskId } = fixture()
    expect(validateProjectTaskGraph(root)).toEqual({
      valid: true,
      errors: [],
      tasks: [{ taskId, schemaVersion: 2, mode: 'legacy-inspect-only', state: 'INSPECT_ONLY' }],
    })
  })

  it('rejects an extra task file instead of silently accepting a partial snapshot', () => {
    const { root, taskId } = fixture()
    writeFileSync(join(root, `.delivery/tasks/${taskId}/forged.txt`), 'forged\n')
    const result = validateProjectTaskGraph(root)
    expect(result.valid).toBe(false)
    expect(result.errors).toContain(`TASK_GRAPH_LEGACY_COMPATIBILITY_INVALID:${taskId}:TASK_FILE_INVENTORY_MISMATCH`)
  })

  it.each([
    ['changed', (path: string) => writeFileSync(path, 'changed\n')],
    ['missing', (path: string) => unlinkSync(path)],
  ])('rejects a %s task file', (_name, mutate) => {
    const result = fixture()
    mutate(join(result.root, `.delivery/tasks/${result.taskId}/CURSOR_PROMPT.md`))
    expect(validateProjectTaskGraph(result.root).errors).toContain(
      `TASK_GRAPH_LEGACY_COMPATIBILITY_INVALID:${result.taskId}:TASK_FILE_INVENTORY_MISMATCH`,
    )
  })

  it('rejects a manifest SHA drift before task classification', () => {
    const { root, manifestPath } = fixture()
    const policyPath = join(root, '.delivery/policy.yaml')
    const policy = parse(readFileSync(policyPath, 'utf8')) as Record<string, any>
    policy.artifactMapping['taskGraph.legacySchemaV2ManifestSha256'] = '0'.repeat(64)
    writeFileSync(policyPath, stringify(policy))
    const result = validateProjectTaskGraph(root)
    expect(result.errors).toContain('TASK_GRAPH_LEGACY_MANIFEST_SHA_MISMATCH')
    expect(result.errors).not.toContain('TASK_GRAPH_LEGACY_MANIFEST_PATH_INVALID')
    expect(manifestPath).toContain('.delivery/compatibility/')
  })

  it('rejects a task-directory symlink', () => {
    const { root, taskId } = fixture()
    symlinkSync(join(root, 'spec.md'), join(root, `.delivery/tasks/${taskId}/unsafe-link`))
    expect(validateProjectTaskGraph(root).errors).toContain(
      `TASK_GRAPH_LEGACY_COMPATIBILITY_INVALID:${taskId}:TASK_GRAPH_LEGACY_FILE_UNSAFE:unsafe-link`,
    )
  })

  it('rejects a symlinked manifest and a special task file', () => {
    const linked = fixture()
    const manifestAbsolute = join(linked.root, linked.manifestPath)
    const target = join(linked.root, 'manifest-target.yaml')
    writeFileSync(target, readFileSync(manifestAbsolute))
    unlinkSync(manifestAbsolute)
    symlinkSync(target, manifestAbsolute)
    expect(validateProjectTaskGraph(linked.root).errors).toContain('TASK_GRAPH_LEGACY_MANIFEST_PATH_INVALID')

    const special = fixture()
    const fifo = join(special.root, `.delivery/tasks/${special.taskId}/special-fifo`)
    execFileSync('/usr/bin/mkfifo', [fifo])
    expect(validateProjectTaskGraph(special.root).errors).toContain(
      `TASK_GRAPH_LEGACY_COMPATIBILITY_INVALID:${special.taskId}:TASK_GRAPH_LEGACY_FILE_UNSAFE:special-fifo`,
    )
  })

  it('rejects a source and runner version mismatch', () => {
    const { root, taskId, manifestPath } = fixture()
    rewriteManifest(root, manifestPath, (manifest) => {
      manifest.entries[0].source.runner.version = '2.1.0-beta.2'
    })
    expect(validateProjectTaskGraph(root).errors).toContain(
      `TASK_GRAPH_LEGACY_COMPATIBILITY_INVALID:${taskId}:RUNNER_SOURCE_VERSION_MISMATCH`,
    )
  })

  it('forbids successor data on a beta history entry', () => {
    const { root, manifestPath } = fixture()
    rewriteManifest(root, manifestPath, (manifest) => {
      manifest.entries[0].successor = {
        taskId: 'forged-successor',
        contractRawSha256: '1'.repeat(64),
        contractDigest: '2'.repeat(64),
        reviewRawSha256: '3'.repeat(64),
        decision: 'REPAIR_REQUIRED',
        findingIds: ['CR-001'],
      }
    })
    expect(validateProjectTaskGraph(root).errors.some((error) => (
      error.startsWith('TASK_GRAPH_LEGACY_MANIFEST_INVALID:')
    ))).toBe(true)
  })

  it('rejects a structurally invalid ledger even when manifest hashes are refreshed', () => {
    const { root, taskId, manifestPath } = fixture()
    const taskRoot = join(root, '.delivery/tasks', taskId)
    const ledgerPath = join(taskRoot, 'ledger.jsonl')
    const event = JSON.parse(readFileSync(ledgerPath, 'utf8')) as Record<string, any>
    event.sequence = 2
    delete event.eventDigest
    event.eventDigest = canonicalDigest(event)
    writeFileSync(ledgerPath, `${JSON.stringify(event)}\n`)
    rewriteManifest(root, manifestPath, (manifest) => {
      manifest.entries[0].ledger.rawSha256 = sha256(readFileSync(ledgerPath))
      manifest.entries[0].ledger.finalEventDigest = event.eventDigest
      manifest.entries[0].files = files(taskRoot)
    })
    expect(validateProjectTaskGraph(root).errors).toContain(
      `TASK_GRAPH_LEGACY_COMPATIBILITY_INVALID:${taskId}:LEDGER_EVENT_SEQUENCE_INVALID:1`,
    )
  })

  it.each([
    ['event digest', (events: Array<Record<string, any>>) => { events[1]!.eventDigest = '0'.repeat(64) }],
    ['previous-event chain', (events: Array<Record<string, any>>) => {
      events[1]!.previousEventDigest = '0'.repeat(64)
      delete events[1]!.eventDigest
      events[1]!.eventDigest = canonicalDigest(events[1])
    }],
    ['contract digest', (events: Array<Record<string, any>>) => {
      events[1]!.contractDigest = '0'.repeat(64)
      delete events[1]!.eventDigest
      events[1]!.eventDigest = canonicalDigest(events[1])
    }],
    ['artifact reference', (events: Array<Record<string, any>>) => {
      events[1]!.artifactRefs[0].sha256 = '0'.repeat(64)
      delete events[1]!.eventDigest
      events[1]!.eventDigest = canonicalDigest(events[1])
    }],
  ])('rejects a forged ledger %s with refreshed manifest hashes', (_name, mutate) => {
    const result = fixture()
    const events = appendValidLegacyEvent(result)
    mutate(events)
    writeLedgerAndRefresh(result, events)
    const errors = validateProjectTaskGraph(result.root).errors
    expect(errors.some((error) => error.startsWith(
      `TASK_GRAPH_LEGACY_COMPATIBILITY_INVALID:${result.taskId}:LEDGER_`,
    ))).toBe(true)
  })

  it('rejects a manifest with non-canonical file ordering', () => {
    const { root, taskId, manifestPath } = fixture()
    rewriteManifest(root, manifestPath, (manifest) => {
      manifest.entries[0].files.reverse()
    })
    expect(validateProjectTaskGraph(root).errors).toContain(
      `TASK_GRAPH_LEGACY_MANIFEST_FILES_NOT_SORTED_UNIQUE:${taskId}`,
    )
  })

  it('fails closed for a malformed manifest-bound ledger event', () => {
    const { root, taskId, manifestPath } = fixture()
    const taskRoot = join(root, '.delivery/tasks', taskId)
    const ledgerPath = join(taskRoot, 'ledger.jsonl')
    writeFileSync(ledgerPath, '{"schemaVersion":2}\n')
    rewriteManifest(root, manifestPath, (manifest) => {
      manifest.entries[0].ledger.rawSha256 = sha256(readFileSync(ledgerPath))
      manifest.entries[0].files = files(taskRoot)
    })
    expect(() => validateProjectTaskGraph(root)).not.toThrow()
    expect(validateProjectTaskGraph(root).errors.some((error) => (
      error.startsWith(`TASK_GRAPH_LEGACY_COMPATIBILITY_INVALID:${taskId}:LEDGER_EVENT_SCHEMA_INVALID:1:`)
    ))).toBe(true)
  })

  it('keeps an unlisted schema-v2 task canonical', () => {
    const { root, taskId } = fixture()
    const policyPath = join(root, '.delivery/policy.yaml')
    const policy = parse(readFileSync(policyPath, 'utf8')) as Record<string, any>
    delete policy.artifactMapping['taskGraph.legacySchemaV2ManifestPath']
    delete policy.artifactMapping['taskGraph.legacySchemaV2ManifestSha256']
    writeFileSync(policyPath, stringify(policy))
    expect(validateProjectTaskGraph(root).tasks).toContainEqual({
      taskId, schemaVersion: 2, mode: 'canonical', state: 'DEFINED',
    })
  })

  it('preserves schema-v1 inspect-only behavior without a manifest', () => {
    const { root, taskId } = fixture()
    const policyPath = join(root, '.delivery/policy.yaml')
    const policy = parse(readFileSync(policyPath, 'utf8')) as Record<string, any>
    delete policy.artifactMapping['taskGraph.legacySchemaV2ManifestPath']
    delete policy.artifactMapping['taskGraph.legacySchemaV2ManifestSha256']
    writeFileSync(policyPath, stringify(policy))
    const contractPath = join(root, `.delivery/tasks/${taskId}/contract.yaml`)
    const unsigned = {
      schemaVersion: 1,
      taskId,
      sopVersion: '1.0.0',
      risk: 'R1',
      state: 'DEFINED',
      implementationOwner: 'codex',
      objective: 'Historical v1 task.',
      scope: ['src/**'],
      nonGoals: [],
      authorityInputs: ['spec.md'],
      acceptance: [{
        id: 'AC-01', observation: 'Inspectable.', positiveCases: ['present'], negativeCases: ['missing'],
      }],
      requiredGates: ['inspect'],
      openChoices: [],
    }
    writeFileSync(contractPath, stringify({ ...unsigned, contractDigest: canonicalDigest(unsigned) }))
    expect(validateProjectTaskGraph(root).tasks).toContainEqual({
      taskId, schemaVersion: 1, mode: 'legacy-inspect-only', state: 'INSPECT_ONLY',
    })
  })

  it('rejects an escaping manifest path and a stale manifest self-digest', () => {
    const escaping = fixture()
    const escapingPolicyPath = join(escaping.root, '.delivery/policy.yaml')
    const escapingPolicy = parse(readFileSync(escapingPolicyPath, 'utf8')) as Record<string, any>
    escapingPolicy.artifactMapping['taskGraph.legacySchemaV2ManifestPath'] = '../outside.yaml'
    writeFileSync(escapingPolicyPath, stringify(escapingPolicy))
    expect(validateProjectTaskGraph(escaping.root).errors).toContain('TASK_GRAPH_LEGACY_MANIFEST_PATH_INVALID')

    const stale = fixture()
    const manifestAbsolute = join(stale.root, stale.manifestPath)
    const manifest = parse(readFileSync(manifestAbsolute, 'utf8')) as Record<string, any>
    manifest.entries[0].reason = 'changed without updating the self digest'
    writeFileSync(manifestAbsolute, stringify(manifest))
    const stalePolicyPath = join(stale.root, '.delivery/policy.yaml')
    const stalePolicy = parse(readFileSync(stalePolicyPath, 'utf8')) as Record<string, any>
    stalePolicy.artifactMapping['taskGraph.legacySchemaV2ManifestSha256'] = sha256(readFileSync(manifestAbsolute))
    writeFileSync(stalePolicyPath, stringify(stalePolicy))
    expect(validateProjectTaskGraph(stale.root).errors).toContain('TASK_GRAPH_LEGACY_MANIFEST_DIGEST_MISMATCH')
  })

  it('rejects duplicate manifest tasks and duplicate file paths', () => {
    const duplicateTask = fixture()
    rewriteManifest(duplicateTask.root, duplicateTask.manifestPath, (manifest) => {
      manifest.entries.push(structuredClone(manifest.entries[0]))
    })
    expect(validateProjectTaskGraph(duplicateTask.root).errors).toContain(
      `TASK_GRAPH_LEGACY_MANIFEST_DUPLICATE_TASK:${duplicateTask.taskId}`,
    )

    const duplicateFile = fixture()
    rewriteManifest(duplicateFile.root, duplicateFile.manifestPath, (manifest) => {
      manifest.entries[0].files.push(structuredClone(manifest.entries[0].files[0]))
    })
    expect(validateProjectTaskGraph(duplicateFile.root).errors).toContain(
      `TASK_GRAPH_LEGACY_MANIFEST_FILES_NOT_SORTED_UNIQUE:${duplicateFile.taskId}`,
    )
  })

  it('rejects distinct manifest entries in non-canonical order', () => {
    const { root, manifestPath } = fixture()
    rewriteManifest(root, manifestPath, (manifest) => {
      const first = structuredClone(manifest.entries[0])
      const second = structuredClone(manifest.entries[0])
      first.taskId = 'z-task'
      second.taskId = 'a-task'
      manifest.entries = [first, second]
    })
    expect(validateProjectTaskGraph(root).errors).toContain(
      'TASK_GRAPH_LEGACY_MANIFEST_ENTRIES_NOT_SORTED_UNIQUE',
    )
  })

  it.each([
    ['task ID', (entry: Record<string, any>) => { entry.taskId = 'forged-task' }],
    ['source version', (entry: Record<string, any>) => { entry.source.sopVersion = '2.1.0-beta.2' }],
  ])('rejects a forged manifest %s binding', (_name, mutate) => {
    const { root, manifestPath } = fixture()
    rewriteManifest(root, manifestPath, (manifest) => mutate(manifest.entries[0]))
    expect(validateProjectTaskGraph(root).valid).toBe(false)
  })

  it('fails closed when a configured manifest loses the complete task root', () => {
    const { root } = fixture()
    rmSync(join(root, '.delivery/tasks'), { recursive: true, force: true })
    expect(validateProjectTaskGraph(root).errors).toContain('TASK_GRAPH_LEGACY_TASK_ROOT_MISSING')
  })

  it.each(['malformed', [], 42, null])('rejects malformed artifactMapping %j', (artifactMapping) => {
    const { root } = fixture()
    const policyPath = join(root, '.delivery/policy.yaml')
    const policy = parse(readFileSync(policyPath, 'utf8')) as Record<string, unknown>
    policy.artifactMapping = artifactMapping
    writeFileSync(policyPath, stringify(policy))
    expect(validateProjectTaskGraph(root).errors).toContain('TASK_GRAPH_LEGACY_MAPPING_INVALID')
  })

  it.each([
    ['contract raw SHA', (entry: Record<string, any>) => { entry.contract.rawSha256 = '0'.repeat(64) }],
    ['contract digest', (entry: Record<string, any>) => { entry.contract.digest = '0'.repeat(64) }],
    ['source policy', (entry: Record<string, any>) => { entry.source.policyDigest = '0'.repeat(64) }],
    ['runner raw SHA', (entry: Record<string, any>) => { entry.source.runner.sha256 = '0'.repeat(64) }],
    ['ledger raw SHA', (entry: Record<string, any>) => { entry.ledger.rawSha256 = '0'.repeat(64) }],
    ['ledger final state', (entry: Record<string, any>) => { entry.ledger.finalState = 'CLOSED' }],
    ['ledger final digest', (entry: Record<string, any>) => { entry.ledger.finalEventDigest = '0'.repeat(64) }],
  ])('rejects forged %s identity', (_name, mutate) => {
    const { root, manifestPath } = fixture()
    rewriteManifest(root, manifestPath, (manifest) => mutate(manifest.entries[0]))
    expect(validateProjectTaskGraph(root).valid).toBe(false)
    expect(validateProjectTaskGraph(root).tasks[0]?.mode).toBe('canonical')
  })

  it('accepts an exact superseded readiness predecessor binding', () => {
    const { root, taskId } = supersededFixture()
    const policy = parse(readFileSync(join(root, '.delivery/policy.yaml'), 'utf8')) as Record<string, unknown>
    const manifest = loadLegacyCompatibilityManifest(root, policy)
    const taskRoot = join(root, '.delivery/tasks', taskId)
    const contractRaw = readFileSync(join(taskRoot, 'contract.yaml'))
    const result = verifyLegacyTaskCompatibility({
      projectRoot: root,
      taskId,
      taskRoot,
      contract: parse(contractRaw.toString('utf8')) as Record<string, unknown>,
      contractRaw,
      entry: manifest.entries.get(taskId),
      compatibilityTaskIds: new Set(manifest.entries.keys()),
    })
    expect(result).toMatchObject({ valid: true, errors: [] })
  })

  it('rejects a successor that drops the predecessor review binding', () => {
    const { root, taskId } = supersededFixture()
    const policy = parse(readFileSync(join(root, '.delivery/policy.yaml'), 'utf8')) as Record<string, any>
    const manifest = loadLegacyCompatibilityManifest(root, policy)
    const entry = manifest.entries.get(taskId)!
    const successorPath = join(root, `.delivery/tasks/${entry.successor!.taskId}/contract.yaml`)
    const successor = parse(readFileSync(successorPath, 'utf8')) as Record<string, any>
    successor.predecessors = []
    delete successor.contractDigest
    successor.contractDigest = canonicalDigest(successor)
    writeFileSync(successorPath, stringify(successor))
    entry.successor!.contractRawSha256 = sha256(readFileSync(successorPath))
    entry.successor!.contractDigest = successor.contractDigest
    const taskRoot = join(root, '.delivery/tasks', taskId)
    const contractRaw = readFileSync(join(taskRoot, 'contract.yaml'))
    const verification = verifyLegacyTaskCompatibility({
      projectRoot: root,
      taskId,
      taskRoot,
      contract: parse(contractRaw.toString('utf8')) as Record<string, unknown>,
      contractRaw,
      entry,
      compatibilityTaskIds: new Set(manifest.entries.keys()),
    })
    expect(verification.errors).toEqual(['SUCCESSOR_PREDECESSOR_BINDING_MISMATCH'])
  })

  it('rejects missing, self, and manifest-listed successors', () => {
    const missing = supersededFixture()
    rewriteManifest(missing.root, missing.manifestPath, (manifest) => {
      delete manifest.entries[0].successor
    })
    expect(validateProjectTaskGraph(missing.root).errors.some((error) => (
      error.startsWith('TASK_GRAPH_LEGACY_MANIFEST_INVALID:')
    ))).toBe(true)

    for (const mode of ['self', 'listed'] as const) {
      const result = supersededFixture()
      const policy = parse(readFileSync(join(result.root, '.delivery/policy.yaml'), 'utf8')) as Record<string, any>
      const manifest = loadLegacyCompatibilityManifest(result.root, policy)
      const entry = manifest.entries.get(result.taskId)!
      const taskRoot = join(result.root, '.delivery/tasks', result.taskId)
      const contractRaw = readFileSync(join(taskRoot, 'contract.yaml'))
      if (mode === 'self') entry.successor!.taskId = result.taskId
      const compatibilityTaskIds = new Set(manifest.entries.keys())
      if (mode === 'listed') compatibilityTaskIds.add(entry.successor!.taskId)
      expect(verifyLegacyTaskCompatibility({
        projectRoot: result.root,
        taskId: result.taskId,
        taskRoot,
        contract: parse(contractRaw.toString('utf8')) as Record<string, unknown>,
        contractRaw,
        entry,
        compatibilityTaskIds,
      }).errors).toContain('SUCCESSOR_BINDING_INVALID')
    }
  })

  it('rejects a beta-version successor and malformed successor bytes', () => {
    const beta = supersededFixture()
    const betaPolicy = parse(readFileSync(join(beta.root, '.delivery/policy.yaml'), 'utf8')) as Record<string, any>
    const betaManifest = loadLegacyCompatibilityManifest(beta.root, betaPolicy)
    const betaEntry = betaManifest.entries.get(beta.taskId)!
    const betaSuccessorPath = join(beta.root, `.delivery/tasks/${betaEntry.successor!.taskId}/contract.yaml`)
    const betaSuccessor = parse(readFileSync(betaSuccessorPath, 'utf8')) as Record<string, any>
    betaSuccessor.sopVersion = '2.1.0-beta.3'
    delete betaSuccessor.contractDigest
    betaSuccessor.contractDigest = canonicalDigest(betaSuccessor)
    writeFileSync(betaSuccessorPath, stringify(betaSuccessor))
    betaEntry.successor!.contractRawSha256 = sha256(readFileSync(betaSuccessorPath))
    betaEntry.successor!.contractDigest = betaSuccessor.contractDigest
    const betaTaskRoot = join(beta.root, '.delivery/tasks', beta.taskId)
    const betaContractRaw = readFileSync(join(betaTaskRoot, 'contract.yaml'))
    expect(verifyLegacyTaskCompatibility({
      projectRoot: beta.root,
      taskId: beta.taskId,
      taskRoot: betaTaskRoot,
      contract: parse(betaContractRaw.toString('utf8')) as Record<string, unknown>,
      contractRaw: betaContractRaw,
      entry: betaEntry,
      compatibilityTaskIds: new Set(betaManifest.entries.keys()),
    }).errors).toContain('SUCCESSOR_CONTRACT_SEMANTIC_DIGEST_MISMATCH')

    const malformed = supersededFixture()
    const malformedPolicy = parse(readFileSync(join(malformed.root, '.delivery/policy.yaml'), 'utf8')) as Record<string, any>
    const malformedManifest = loadLegacyCompatibilityManifest(malformed.root, malformedPolicy)
    const malformedEntry = malformedManifest.entries.get(malformed.taskId)!
    const malformedSuccessorPath = join(
      malformed.root,
      `.delivery/tasks/${malformedEntry.successor!.taskId}/contract.yaml`,
    )
    writeFileSync(malformedSuccessorPath, 'null\n')
    malformedEntry.successor!.contractRawSha256 = sha256(readFileSync(malformedSuccessorPath))
    const malformedTaskRoot = join(malformed.root, '.delivery/tasks', malformed.taskId)
    const malformedContractRaw = readFileSync(join(malformedTaskRoot, 'contract.yaml'))
    expect(() => verifyLegacyTaskCompatibility({
      projectRoot: malformed.root,
      taskId: malformed.taskId,
      taskRoot: malformedTaskRoot,
      contract: parse(malformedContractRaw.toString('utf8')) as Record<string, unknown>,
      contractRaw: malformedContractRaw,
      entry: malformedEntry,
      compatibilityTaskIds: new Set(malformedManifest.entries.keys()),
    })).not.toThrow()

    const malformedReview = supersededFixture()
    const reviewPolicy = parse(readFileSync(join(malformedReview.root, '.delivery/policy.yaml'), 'utf8')) as Record<string, any>
    const reviewManifest = loadLegacyCompatibilityManifest(malformedReview.root, reviewPolicy)
    const reviewEntry = reviewManifest.entries.get(malformedReview.taskId)!
    const reviewPath = join(malformedReview.root, `.delivery/tasks/${malformedReview.taskId}/contract-review.yaml`)
    writeFileSync(reviewPath, 'null\n')
    reviewEntry.successor!.reviewRawSha256 = sha256(readFileSync(reviewPath))
    const reviewSuccessorPath = join(
      malformedReview.root,
      `.delivery/tasks/${reviewEntry.successor!.taskId}/contract.yaml`,
    )
    const reviewSuccessor = parse(readFileSync(reviewSuccessorPath, 'utf8')) as Record<string, any>
    reviewSuccessor.predecessors[0].reviewRawSha256 = reviewEntry.successor!.reviewRawSha256
    delete reviewSuccessor.contractDigest
    reviewSuccessor.contractDigest = canonicalDigest(reviewSuccessor)
    writeFileSync(reviewSuccessorPath, stringify(reviewSuccessor))
    reviewEntry.successor!.contractRawSha256 = sha256(readFileSync(reviewSuccessorPath))
    reviewEntry.successor!.contractDigest = reviewSuccessor.contractDigest
    const reviewTaskRoot = join(malformedReview.root, '.delivery/tasks', malformedReview.taskId)
    const reviewContractRaw = readFileSync(join(reviewTaskRoot, 'contract.yaml'))
    const reviewVerification = verifyLegacyTaskCompatibility({
      projectRoot: malformedReview.root,
      taskId: malformedReview.taskId,
      taskRoot: reviewTaskRoot,
      contract: parse(reviewContractRaw.toString('utf8')) as Record<string, unknown>,
      contractRaw: reviewContractRaw,
      entry: reviewEntry,
      compatibilityTaskIds: new Set(reviewManifest.entries.keys()),
    })
    expect(reviewVerification.errors).toContain('SUCCESSOR_PREDECESSOR_REVIEW_INVALID')
  })

  it('rejects a disallowed superseded state and predecessor graph cycle', () => {
    const state = supersededFixture()
    rewriteManifest(state.root, state.manifestPath, (manifest) => {
      manifest.entries[0].ledger.finalState = 'IN_PROGRESS'
    })
    expect(validateProjectTaskGraph(state.root).errors.some((error) => (
      error.startsWith('TASK_GRAPH_LEGACY_MANIFEST_INVALID:')
    ))).toBe(true)

    const cycle = supersededFixture()
    const cyclePolicy = parse(readFileSync(join(cycle.root, '.delivery/policy.yaml'), 'utf8')) as Record<string, any>
    const cycleManifest = loadLegacyCompatibilityManifest(cycle.root, cyclePolicy)
    const cycleEntry = cycleManifest.entries.get(cycle.taskId)!
    const successorPath = join(cycle.root, `.delivery/tasks/${cycleEntry.successor!.taskId}/contract.yaml`)
    const successor = parse(readFileSync(successorPath, 'utf8')) as Record<string, any>
    const cycleId = 'cycle-task'
    const cycleRoot = join(cycle.root, '.delivery/tasks', cycleId)
    mkdirSync(cycleRoot, { recursive: true })
    const binding = {
      taskId: cycleId,
      contractPath: `.delivery/tasks/${cycleId}/contract.yaml`,
      contractRawSha256: '1'.repeat(64),
      contractDigest: '2'.repeat(64),
      reviewPath: `.delivery/tasks/${cycleId}/contract-review.yaml`,
      reviewRawSha256: '3'.repeat(64),
      decision: 'REPAIR_REQUIRED',
      findingIds: ['CR-CYCLE'],
    }
    successor.predecessors.push(binding)
    delete successor.contractDigest
    successor.contractDigest = canonicalDigest(successor)
    writeFileSync(successorPath, stringify(successor))
    cycleEntry.successor!.contractRawSha256 = sha256(readFileSync(successorPath))
    cycleEntry.successor!.contractDigest = successor.contractDigest
    const cycleContract = { ...successor, taskId: cycleId, predecessors: [binding] }
    delete cycleContract.contractDigest
    cycleContract.contractDigest = canonicalDigest(cycleContract)
    writeFileSync(join(cycleRoot, 'contract.yaml'), stringify(cycleContract))
    const taskRoot = join(cycle.root, '.delivery/tasks', cycle.taskId)
    const contractRaw = readFileSync(join(taskRoot, 'contract.yaml'))
    expect(verifyLegacyTaskCompatibility({
      projectRoot: cycle.root,
      taskId: cycle.taskId,
      taskRoot,
      contract: parse(contractRaw.toString('utf8')) as Record<string, unknown>,
      contractRaw,
      entry: cycleEntry,
      compatibilityTaskIds: new Set(cycleManifest.entries.keys()),
    }).errors).toContain('SUCCESSOR_PREDECESSOR_GRAPH_CYCLE')
  })
})
