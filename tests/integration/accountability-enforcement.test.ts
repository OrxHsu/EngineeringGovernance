import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import { parse } from 'yaml'

import { appendAccountabilityEvent, deriveAccountabilityStatus } from '../../src/accountability/derive.js'
import { actorEligibilityErrors } from '../../src/accountability/enforce.js'
import { generateRecoveryPlan } from '../../src/accountability/recovery.js'
import { accountabilityStatus } from '../../src/commands/accountability-status.js'
import { canonicalDigest } from '../../src/model/digest.js'
import { rebindAccountabilityFixture } from '../helpers/accountability-fixture.js'

const projectRoot = process.cwd()
const temporary: string[] = []

function fixture(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'accountability-ledger-boundary-')))
  temporary.push(root)
  mkdirSync(join(root, '.delivery', 'accountability'), { recursive: true })
  mkdirSync(join(root, '.delivery', 'tasks'), { recursive: true })
  cpSync(join(projectRoot, '.delivery', 'policy.yaml'), join(root, '.delivery', 'policy.yaml'))
  cpSync(join(projectRoot, '.delivery', 'bin'), join(root, '.delivery', 'bin'), { recursive: true })
  for (const taskId of ['global-sop-2-1-beta-1-fix-1', 'global-sop-2-1-beta-1-fix-1-repair-3']) {
    cpSync(join(projectRoot, '.delivery', 'tasks', taskId), join(root, '.delivery', 'tasks', taskId), { recursive: true })
  }
  cpSync(join(projectRoot, '.delivery', 'accountability', 'actors.jsonl'), join(root, '.delivery', 'accountability', 'actors.jsonl'))
  cpSync(join(projectRoot, '.delivery', 'accountability', 'events.jsonl'), join(root, '.delivery', 'accountability', 'events.jsonl'))
  rebindAccountabilityFixture(root, projectRoot)
  return root
}

function forgedStandingInput(root: string) {
  const sourcePath = join(root, '.delivery', 'tasks', 'global-sop-2-1-beta-1-fix-1', 'contract-review.yaml')
  const sourceRaw = readFileSync(sourcePath)
  return {
    schemaVersion: 1 as const,
    artifactType: 'engineering-governance-accountability-event-v1' as const,
    eventType: 'standing_changed' as const,
    subjectActorId: 'codex',
    source: {
      taskId: 'global-sop-2-1-beta-1-fix-1',
      artifactPath: '.delivery/tasks/global-sop-2-1-beta-1-fix-1/contract-review.yaml',
      rawSha256: 'eb000aebfd08ff7c2fe58663e5e492bc9863c402792afdd3a9cc3636916ca2d6',
      semanticDigest: canonicalDigest(parse(sourceRaw.toString('utf8'))),
      reviewId: 'crv-global-sop-2-1-beta-1-fix-1-689fcb1ee3a4c81eaf80cfccf951963cd44414c786c6832940539eac1ae9cc4e',
      findingId: 'none',
    },
    score: { base: 0, repeatSurcharge: 0, immediateSuspension: false, delta: 0 },
    lifetimePenaltyScore: 20,
    activePenaltyScore: 0,
    standing: 'GOOD_STANDING' as const,
    permissions: ['author', 'owner', 'contract-reviewer', 'implementation-reviewer', 'supervise'],
    authorization: 'none',
    occurredAt: '2026-08-16T02:48:00.000Z',
  }
}

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('beta1 accountability enforcement', () => {
  it('recomputes the bootstrap sanction and rejects a non-remediation owner role', () => {
    expect(accountabilityStatus(process.cwd(), 'codex')).toMatchObject({ activePenaltyScore: 20, standing: 'SUSPENDED' })
    expect(actorEligibilityErrors({ projectRoot: process.cwd(), taskId: 'unrelated-task', actorId: 'codex', role: 'implementation-owner', risk: 'R3' })).toContain('ACCOUNTABILITY_SUSPENDED_ROLE_FORBIDDEN')
  })

  it('builds the five-task beta3 recovery path without mutating status', () => {
    const before = accountabilityStatus(process.cwd(), 'codex')
    expect(generateRecoveryPlan(process.cwd(), 'codex')).toMatchObject({
      currentStanding: 'SUSPENDED',
      estimatedTasks: 5,
      permanentGatesSatisfied: false,
    })
    expect(accountabilityStatus(process.cwd(), 'codex')).toEqual(before)
  })

  it('rejects a directly forged standing change even when its hash chain and cached status fields are self-consistent', () => {
    const root = fixture()
    const path = join(root, '.delivery', 'accountability', 'events.jsonl')
    const previous = JSON.parse(readFileSync(path, 'utf8').trim().split('\n').at(-1)!) as Record<string, unknown>
    const unsigned = {
      ...forgedStandingInput(root),
      sequence: 3,
      priorEventDigest: previous.eventDigest,
      policyDigest: '258befcfe9f8d24f8ba031e8a99941043e7fbfaba557a16949b10169fd02205f',
    }
    appendFileSync(path, `${JSON.stringify({ ...unsigned, eventDigest: canonicalDigest(unsigned) })}\n`)
    expect(() => deriveAccountabilityStatus(root, 'codex')).toThrow('ACCOUNTABILITY_EVENT_TRANSITION_INVALID')
  })

  it('validates caller-supplied event state before append and leaves the ledger unchanged on rejection', () => {
    const root = fixture()
    const path = join(root, '.delivery', 'accountability', 'events.jsonl')
    const before = readFileSync(path, 'utf8')
    expect(() => appendAccountabilityEvent(root, forgedStandingInput(root))).toThrow('ACCOUNTABILITY_EVENT_TRANSITION_INVALID')
    expect(readFileSync(path, 'utf8')).toBe(before)
  })

  it('fails closed when a bootstrap sanction event is omitted', () => {
    const root = fixture()
    writeFileSync(join(root, '.delivery', 'accountability', 'events.jsonl'), '')
    expect(() => deriveAccountabilityStatus(root, 'codex')).toThrow('ACCOUNTABILITY_EVENT_BOOTSTRAP_MISSING')
  })
})
