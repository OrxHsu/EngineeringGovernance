import { mkdirSync, readFileSync, rmSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { canonicalDigest } from '../../src/model/digest.js'
import { ACCOUNTABILITY_GENESIS_DIGEST } from '../../src/accountability/policy.js'
import {
  enforcePermanentGates,
  installPermanentGate,
  loadPermanentGates,
  recordPermanentGateTrigger,
} from '../../src/accountability/permanent-gates.js'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true })
})

function input() {
  return {
    schemaVersion: 2 as const,
    taskId: 'beta3-task',
    contractAuthor: 'codex',
    implementationOwner: 'owner',
    objective: 'Implement source without its test.',
    scope: ['src/example.ts'],
    nonGoals: [],
    authorityInputs: ['src/example.ts'],
    repositories: [],
    acceptance: [{ id: 'AC-01', bindingRefs: ['source'], positiveCases: ['works'], negativeCases: ['fails'] }],
    authorizationRequirements: [],
    evidenceFreshnessMs: 1000,
    designBindings: {
      deliverables: [{ id: 'source', repositoryId: 'root', path: 'src/example.ts', kind: 'source', schemaRef: 'none', artifactType: 'source' }],
      authorities: [{ id: 'authority', location: 'repository', repositoryId: 'root', path: 'src/example.ts', rawSha256: '0'.repeat(64), semanticDigest: '0'.repeat(64) }],
    },
    predecessors: [],
    openChoices: [],
    signals: { mutation: true },
  }
}

function writeGateSourceEvents(root: string, suffix: string): string {
  const common = {
    schemaVersion: 1,
    artifactType: 'engineering-governance-accountability-event-v1',
    policyDigest: '0'.repeat(64),
    subjectActorId: 'codex',
    lifetimePenaltyScore: 3,
    activePenaltyScore: 3,
    standing: 'WARNING',
    permissions: ['r0', 'r1', 'r2-supervised'],
    authorization: 'none',
  }
  const firstUnsigned = {
    ...common,
    eventType: 'finding_assessed',
    sequence: 1,
    priorEventDigest: ACCOUNTABILITY_GENESIS_DIGEST,
    source: { taskId: `finding-${suffix}`, artifactPath: `finding-${suffix}.yaml`, rawSha256: '1'.repeat(64), semanticDigest: '2'.repeat(64), reviewId: 'review-1', findingId: 'F-001' },
    score: { base: 3, repeatSurcharge: 0, immediateSuspension: false, delta: 3 },
    occurredAt: '2026-08-16T00:00:00.000Z',
  }
  const first = { ...firstUnsigned, eventDigest: canonicalDigest(firstUnsigned) }
  const secondUnsigned = {
    ...common,
    eventType: 'calibration_recorded',
    sequence: 2,
    priorEventDigest: first.eventDigest,
    source: { taskId: 'remediation-1', artifactPath: 'review.yaml', rawSha256: '3'.repeat(64), semanticDigest: '4'.repeat(64), reviewId: 'review-2', findingId: 'calibration' },
    score: { base: 0, repeatSurcharge: 0, immediateSuspension: false, delta: 0 },
    occurredAt: '2026-08-16T00:01:00.000Z',
  }
  const second = { ...secondUnsigned, eventDigest: canonicalDigest(secondUnsigned) }
  const directory = join(root, '.delivery/accountability')
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'events.jsonl'), `${JSON.stringify(first)}\n${JSON.stringify(second)}\n`)
  return second.eventDigest
}

describe('permanent accountability gates', () => {
  it('installs a mapped gate, blocks its preflight rule, and chains trigger history', () => {
    const root = mkdtempSync(join(tmpdir(), 'beta3-gates-'))
    temporaryDirectories.push(root)
    const remediationEventDigest = writeGateSourceEvents(root, 'one')
    const installed = installPermanentGate({
      projectRoot: root,
      actorId: 'Codex',
      defectClass: 'Missing_Test File',
      taskId: 'remediation-1',
      findingId: 'F-001',
      remediationEventDigest,
      installedAt: '2026-08-16T00:00:00.000Z',
    })
    expect(installed.gates[0]).toMatchObject({
      defectClass: 'missing-test-file', gateType: 'preflight-check', rule: 'source-test-pairing',
    })

    const result = enforcePermanentGates(root, 'codex', input() as never, 'R1')
    expect(result.valid).toBe(false)
    expect(result.errors[0]).toContain('PERMANENT_GATE_BLOCKED')

    const next = recordPermanentGateTrigger({
      projectRoot: root,
      actorId: 'codex',
      gateId: installed.gates[0]!.gateId,
      taskId: 'beta3-task',
      blocked: true,
      triggeredAt: '2026-08-16T00:01:00.000Z',
    })
    expect(next.gates[0]!.triggerHistory).toHaveLength(1)
    expect(loadPermanentGates(root, 'codex')).toEqual(next)
  })

  it('fails closed when a trigger chain is rewritten', () => {
    const root = mkdtempSync(join(tmpdir(), 'beta3-gates-tamper-'))
    temporaryDirectories.push(root)
    const remediationEventDigest = writeGateSourceEvents(root, 'two')
    const installed = installPermanentGate({
      projectRoot: root, actorId: 'codex', defectClass: 'missing-test-file', taskId: 'remediation-1',
      findingId: 'F-001', remediationEventDigest, installedAt: '2026-08-16T00:00:00.000Z',
    })
    recordPermanentGateTrigger({ projectRoot: root, actorId: 'codex', gateId: installed.gates[0]!.gateId, taskId: 'task-1', blocked: true })
    const path = join(root, '.delivery/accountability/permanent-gates/codex.json')
    const document = JSON.parse(readFileSync(path, 'utf8'))
    document.gates[0].triggerHistory[0].blocked = false
    writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`)
    expect(() => loadPermanentGates(root, 'codex')).toThrow('ACCOUNTABILITY_PERMANENT_GATES_DIGEST_INVALID')
  })
})
