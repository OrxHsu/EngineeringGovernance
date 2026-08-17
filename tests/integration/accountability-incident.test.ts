import { createHash } from 'node:crypto'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import { stringify } from 'yaml'

import { deriveAccountabilityStatus, readAccountabilityEvents } from '../../src/accountability/derive.js'
import {
  applyAccountabilityIncident,
  planAccountabilityIncident,
} from '../../src/commands/accountability-incident.js'
import { canonicalDigest } from '../../src/model/digest.js'
import { validateProjectTaskGraph } from '../../src/project/task-graph.js'
import { rebindAccountabilityFixture } from '../helpers/accountability-fixture.js'

const sourceRoot = process.cwd()
const temporary: string[] = []

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

function fixture(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'sop-accountability-incident-')))
  temporary.push(root)
  mkdirSync(join(root, '.delivery', 'accountability'), { recursive: true })
  mkdirSync(join(root, '.delivery', 'tasks'), { recursive: true })
  cpSync(join(sourceRoot, '.delivery', 'policy.yaml'), join(root, '.delivery', 'policy.yaml'))
  cpSync(join(sourceRoot, '.delivery', 'bin'), join(root, '.delivery', 'bin'), { recursive: true })
  for (const taskId of ['global-sop-2-1-beta-1-fix-1', 'global-sop-2-1-beta-1-fix-1-repair-3']) {
    cpSync(join(sourceRoot, '.delivery', 'tasks', taskId), join(root, '.delivery', 'tasks', taskId), { recursive: true })
  }
  cpSync(join(sourceRoot, '.delivery', 'accountability', 'actors.jsonl'), join(root, '.delivery', 'accountability', 'actors.jsonl'))
  cpSync(join(sourceRoot, '.delivery', 'accountability', 'events.jsonl'), join(root, '.delivery', 'accountability', 'events.jsonl'))
  rebindAccountabilityFixture(root, sourceRoot)
  return root
}

function incidentInput(
  root: string,
  options: {
    incidentId?: string
    blockedComponent?: 'governance-tool' | 'contract-review'
  } = {},
): string {
  const evidencePath = join(root, 'blocked-review.txt')
  const evidence = 'CONTRACT_REVIEW_REQUEST_SELF_REVIEW_REQUIRED\n'
  writeFileSync(evidencePath, evidence)
  const blockedComponent = options.blockedComponent ?? 'contract-review'
  const incident = {
    schemaVersion: 1,
    artifactType: 'engineering-governance-accountability-incident-v1',
    incidentId: options.incidentId ?? 'blocked-review-accountability-gap',
    projectRoot: root,
    subjectActorId: 'independent-implementation-reviewer-fix1',
    reportedBy: 'user-authority',
    failureContext: {
      blockedComponent,
      failureCode: blockedComponent === 'governance-tool' ? 'GOVERNANCE_TOOL_BLOCKED' : 'CONTRACT_REVIEW_BLOCKED',
      conversationId: '01a00b68-4cc7-79c1-b422-832192be91e2',
      observedAt: '2026-08-17T08:00:00.000Z',
    },
    finding: {
      findingId: 'INC-001',
      severity: 'BLOCKER',
      classification: 'newly_discovered_defect',
      defectClass: 'blocked-accountability-recording',
      responsibleRole: 'implementation_reviewer',
      culpability: 'culpable',
      observation: 'The normal review path is blocked, so accountability must be recorded independently.',
    },
    evidenceRefs: [{
      path: 'blocked-review.txt',
      rawSha256: sha256(evidence),
      semanticDigest: canonicalDigest(evidence),
    }],
    grantor: { id: 'user-authority', role: 'user', trustLevel: 'local-claim' },
    issuedAt: '2026-08-17T08:01:00.000Z',
    expiresAt: '2026-08-18T08:01:00.000Z',
    status: 'approved',
  }
  const path = join(root, 'incident.yaml')
  writeFileSync(path, stringify(incident))
  return path
}

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('failure-tolerant accountability incidents', () => {
  it('records a user-authorized deduction without a task or review transition', () => {
    const root = fixture()
    const inputPath = incidentInput(root)
    const beforeEvents = readAccountabilityEvents(root).length
    const plan = planAccountabilityIncident(root, inputPath)
    expect(plan.event.score.delta).toBe(3)
    expect(plan.event.incident?.failureContext.blockedComponent).toBe('contract-review')
    const result = applyAccountabilityIncident(plan, plan.digest) as { status: { activePenaltyScore: number; standing: string } }
    expect(readAccountabilityEvents(root)).toHaveLength(beforeEvents + 1)
    expect(result.status).toMatchObject({ activePenaltyScore: 3, standing: 'WARNING' })
    expect(deriveAccountabilityStatus(root, 'independent-implementation-reviewer-fix1').sourceEvents.at(-1)?.sourceRef).toBe(
      'incident:blocked-review-accountability-gap:INC-001',
    )
  })

  it('refuses apply when evidence drifts after planning', () => {
    const root = fixture()
    const inputPath = incidentInput(root)
    const plan = planAccountabilityIncident(root, inputPath)
    writeFileSync(join(root, 'blocked-review.txt'), 'changed\n')
    expect(() => applyAccountabilityIncident(plan, plan.digest)).toThrow('MANAGED_FILE_CHANGED')
  })

  it('records an incident without depending on a healthy task graph', () => {
    const root = fixture()
    const brokenTaskRoot = join(root, '.delivery', 'tasks', 'broken-governance-task')
    mkdirSync(brokenTaskRoot, { recursive: true })
    writeFileSync(join(brokenTaskRoot, 'contract.yaml'), 'schemaVersion: 2\ntaskId: broken-governance-task\n')
    expect(validateProjectTaskGraph(root).valid).toBe(false)

    const inputPath = incidentInput(root, {
      incidentId: 'governance-tool-accountability-gap',
      blockedComponent: 'governance-tool',
    })
    const plan = planAccountabilityIncident(root, inputPath)
    expect(plan.event.incident?.failureContext.blockedComponent).toBe('governance-tool')
    const result = applyAccountabilityIncident(plan, plan.digest) as { applied: string[] }
    expect(result.applied).toHaveLength(1)
  })
})
