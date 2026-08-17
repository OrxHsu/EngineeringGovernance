import { createHash } from 'node:crypto'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import { parse, stringify } from 'yaml'

import {
  isRemediationBridgeContract,
  remediationBridgeErrors,
} from '../../src/accountability/enforce.js'
import { canonicalDigest } from '../../src/model/digest.js'
import { validateDocument } from '../../src/policy/load.js'
import {
  ACCOUNTABILITY_FIXTURE_ROOT,
  rebindAccountabilityFixture,
  rebindRuntimeCommands,
} from '../helpers/accountability-fixture.js'

const projectRoot = process.cwd()
const fixtureRoot = ACCOUNTABILITY_FIXTURE_ROOT
const taskId = 'global-sop-2-1-beta-1-fix-1-repair-4'
const predecessorTaskId = 'global-sop-2-1-beta-1-fix-1-repair-3'
const temporary: string[] = []

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

function rewriteRoot(value: unknown, from: string, to: string): unknown {
  if (typeof value === 'string') return value.replaceAll(from, to).replaceAll('/__RELEASE_PROJECT_ROOT__', to)
  if (Array.isArray(value)) return value.map((item) => rewriteRoot(item, from, to))
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, rewriteRoot(entry, from, to)]))
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

function rewriteTask(value: unknown, from: string, to: string): unknown {
  if (typeof value === 'string') return value.replaceAll(from, to)
  if (Array.isArray(value)) return value.map((item) => rewriteTask(item, from, to))
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, rewriteTask(entry, from, to)]))
}

function bindReviewToContract(review: Record<string, any>, task: string, contract: Record<string, any>, contractText: string): void {
  review.taskId = task
  review.reviewId = `crv-${task}-${contract.contractDigest}`
  review.contract.path = join(review.contract.path.split('/.delivery/')[0], '.delivery', 'tasks', task, 'contract.yaml')
  review.contract.rawSha256 = sha256(contractText)
  review.contract.digest = contract.contractDigest
  for (const section of [review.checklist, review.r3Requirements]) {
    for (const item of Object.values(section ?? {}) as Array<Record<string, any>>) {
      for (const ref of item.evidenceRefs ?? []) {
        if (ref.kind === 'contract' && String(ref.path).endsWith('/contract.yaml')) {
          ref.path = `.delivery/tasks/${task}/contract.yaml`
          ref.sha256 = sha256(contractText)
          ref.digest = canonicalDigest(contract)
        }
      }
    }
  }
}

function fixture(): { root: string; taskRoot: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'accountability-bridge-')))
  temporary.push(root)
  mkdirSync(join(root, '.delivery', 'tasks'), { recursive: true })
  cpSync(join(projectRoot, '.delivery', 'policy.yaml'), join(root, '.delivery', 'policy.yaml'))
  cpSync(join(projectRoot, '.delivery', 'bin'), join(root, '.delivery', 'bin'), { recursive: true })
  mkdirSync(join(root, '.delivery', 'accountability'), { recursive: true })
  cpSync(join(fixtureRoot, 'actors.jsonl'), join(root, '.delivery', 'accountability', 'actors.jsonl'))
  cpSync(join(fixtureRoot, 'events.jsonl'), join(root, '.delivery', 'accountability', 'events.jsonl'))
  cpSync(
    join(fixtureRoot, 'tasks', predecessorTaskId),
    join(root, '.delivery', 'tasks', predecessorTaskId),
    { recursive: true },
  )
  cpSync(
    join(fixtureRoot, 'tasks', 'global-sop-2-1-beta-1-fix-1'),
    join(root, '.delivery', 'tasks', 'global-sop-2-1-beta-1-fix-1'),
    { recursive: true },
  )

  const taskRoot = join(root, '.delivery', 'tasks', taskId)
  mkdirSync(join(taskRoot, 'authorizations'), { recursive: true })
  const contractSource = parse(readFileSync(join(fixtureRoot, 'tasks', taskId, 'contract.yaml'), 'utf8')) as Record<string, any>
  const rewritten = rebindRuntimeCommands(rewriteRoot(contractSource, projectRoot, root)) as Record<string, any>
  const { contractDigest: _discarded, ...unsignedContract } = rewritten
  const contract = { ...unsignedContract, contractDigest: canonicalDigest(unsignedContract) }
  const contractText = stringify(contract, { lineWidth: 0 })
  writeFileSync(join(taskRoot, 'contract.yaml'), contractText)

  const review = rewriteRoot(
    parse(readFileSync(join(fixtureRoot, 'tasks', taskId, 'contract-review.yaml'), 'utf8')),
    projectRoot,
    root,
  ) as Record<string, any>
  review.reviewId = `crv-${taskId}-${contract.contractDigest}`
  review.contract.rawSha256 = sha256(contractText)
  review.contract.digest = contract.contractDigest
  for (const item of Object.values(review.checklist) as Array<Record<string, any>>) {
    for (const ref of item.evidenceRefs ?? []) {
      if (ref.path === `.delivery/tasks/${taskId}/contract.yaml`) {
        ref.sha256 = sha256(contractText)
        ref.digest = canonicalDigest(contract)
      }
    }
  }
  for (const item of Object.values(review.r3Requirements) as Array<Record<string, any>>) {
    for (const ref of item.evidenceRefs ?? []) {
      if (ref.path === `.delivery/tasks/${taskId}/contract.yaml`) {
        ref.sha256 = sha256(contractText)
        ref.digest = canonicalDigest(contract)
      }
    }
  }
  writeFileSync(join(taskRoot, 'contract-review.yaml'), stringify(review, { lineWidth: 0 }))

  const requirement = contract.authorizationRequirements[0]
  const lifecycle = rewriteRoot(
    JSON.parse(readFileSync(join(fixtureRoot, 'tasks', taskId, 'authorizations', `${requirement.id}.json`), 'utf8')),
    projectRoot,
    root,
  ) as Record<string, any>
  lifecycle.contractDigest = contract.contractDigest
  lifecycle.target = requirement.target
  lifecycle.scope = requirement.scope
  const lifecyclePath = join(taskRoot, 'authorizations', `${requirement.id}.json`)
  writeJson(lifecyclePath, lifecycle)
  const lifecycleRaw = readFileSync(lifecyclePath)

  const sidecar = rewriteRoot(
    JSON.parse(readFileSync(join(fixtureRoot, 'tasks', taskId, 'remediation-authorization.json'), 'utf8')),
    projectRoot,
    root,
  ) as Record<string, any>
  sidecar.contract.rawSha256 = sha256(contractText)
  sidecar.contract.semanticDigest = contract.contractDigest
  sidecar.lifecycleAuthorization.rawSha256 = sha256(lifecycleRaw)
  sidecar.lifecycleAuthorization.semanticDigest = canonicalDigest(lifecycle)
  sidecar.target = requirement.target
  sidecar.scope = requirement.scope
  writeJson(join(taskRoot, 'remediation-authorization.json'), sidecar)
  const bootstrap = rewriteRoot(
    parse(readFileSync(join(fixtureRoot, 'tasks', taskId, 'accountability-bootstrap.yaml'), 'utf8')),
    projectRoot,
    root,
  )
  writeFileSync(join(taskRoot, 'accountability-bootstrap.yaml'), stringify(bootstrap, { lineWidth: 0 }))
  rebindAccountabilityFixture(root, projectRoot)
  return { root, taskRoot }
}

function forgeCopiedPredecessor(root: string, taskRoot: string): void {
  const forgedId = 'forged-predecessor'
  const originalRoot = join(root, '.delivery', 'tasks', predecessorTaskId)
  const forgedRoot = join(root, '.delivery', 'tasks', forgedId)
  cpSync(originalRoot, forgedRoot, { recursive: true })

  const predecessorContract = rewriteTask(
    parse(readFileSync(join(forgedRoot, 'contract.yaml'), 'utf8')),
    predecessorTaskId,
    forgedId,
  ) as Record<string, any>
  const { contractDigest: _oldPredecessorDigest, ...unsignedPredecessor } = predecessorContract
  predecessorContract.contractDigest = canonicalDigest(unsignedPredecessor)
  const predecessorContractText = stringify(predecessorContract, { lineWidth: 0 })
  writeFileSync(join(forgedRoot, 'contract.yaml'), predecessorContractText)

  const predecessorReview = rewriteTask(
    parse(readFileSync(join(forgedRoot, 'contract-review.yaml'), 'utf8')),
    predecessorTaskId,
    forgedId,
  ) as Record<string, any>
  bindReviewToContract(predecessorReview, forgedId, predecessorContract, predecessorContractText)
  const predecessorReviewText = stringify(predecessorReview, { lineWidth: 0 })
  writeFileSync(join(forgedRoot, 'contract-review.yaml'), predecessorReviewText)

  const defect = rewriteTask(
    parse(readFileSync(join(forgedRoot, 'contract-defect.yaml'), 'utf8')),
    predecessorTaskId,
    forgedId,
  ) as Record<string, any>
  defect.authorities.contract.path = `.delivery/tasks/${forgedId}/contract.yaml`
  defect.authorities.contract.rawSha256 = sha256(predecessorContractText)
  defect.authorities.contract.semanticDigest = predecessorContract.contractDigest
  defect.authorities.acceptedContractReview.path = `.delivery/tasks/${forgedId}/contract-review.yaml`
  defect.authorities.acceptedContractReview.rawSha256 = sha256(predecessorReviewText)
  const defectText = stringify(defect, { lineWidth: 0 })
  writeFileSync(join(forgedRoot, 'contract-defect.yaml'), defectText)

  const predecessorEvents = readFileSync(join(forgedRoot, 'ledger.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Record<string, any>)
  let previousDigest: string | null = null
  for (const [index, event] of predecessorEvents.entries()) {
    event.contractDigest = predecessorContract.contractDigest
    event.sequence = index + 1
    event.previousEventDigest = previousDigest
    for (const reference of event.artifactRefs) {
      if (reference.kind === 'contract') {
        reference.path = `.delivery/tasks/${forgedId}/contract.yaml`
        reference.sha256 = sha256(predecessorContractText)
      } else if (reference.kind === 'contract-review') {
        reference.path = `.delivery/tasks/${forgedId}/contract-review.yaml`
        reference.sha256 = sha256(predecessorReviewText)
      } else if (reference.kind === 'contract-defect') {
        reference.path = `.delivery/tasks/${forgedId}/contract-defect.yaml`
        reference.sha256 = sha256(defectText)
      }
    }
    const { eventDigest: _oldEventDigest, ...unsignedEvent } = event
    event.eventDigest = canonicalDigest(unsignedEvent)
    previousDigest = event.eventDigest
  }
  writeFileSync(join(forgedRoot, 'ledger.jsonl'), `${predecessorEvents.map((event) => JSON.stringify(event)).join('\n')}\n`)

  const contract = parse(readFileSync(join(taskRoot, 'contract.yaml'), 'utf8')) as Record<string, any>
  contract.authorityInputs = contract.authorityInputs.map((path: string) => path.replaceAll(
    `.delivery/tasks/${predecessorTaskId}/`,
    `.delivery/tasks/${forgedId}/`,
  ))
  const { contractDigest: _oldCurrentDigest, ...unsignedContract } = contract
  contract.contractDigest = canonicalDigest(unsignedContract)
  const contractText = stringify(contract, { lineWidth: 0 })
  writeFileSync(join(taskRoot, 'contract.yaml'), contractText)

  const review = parse(readFileSync(join(taskRoot, 'contract-review.yaml'), 'utf8')) as Record<string, any>
  bindReviewToContract(review, taskId, contract, contractText)
  writeFileSync(join(taskRoot, 'contract-review.yaml'), stringify(review, { lineWidth: 0 }))

  const requirement = contract.authorizationRequirements[0]
  const lifecyclePath = join(taskRoot, 'authorizations', `${requirement.id}.json`)
  const lifecycle = JSON.parse(readFileSync(lifecyclePath, 'utf8')) as Record<string, any>
  lifecycle.contractDigest = contract.contractDigest
  lifecycle.target = requirement.target
  lifecycle.scope = requirement.scope
  writeJson(lifecyclePath, lifecycle)
  const lifecycleRaw = readFileSync(lifecyclePath)
  const sidecarPath = join(taskRoot, 'remediation-authorization.json')
  const sidecar = JSON.parse(readFileSync(sidecarPath, 'utf8')) as Record<string, any>
  sidecar.contract.rawSha256 = sha256(contractText)
  sidecar.contract.semanticDigest = contract.contractDigest
  sidecar.lifecycleAuthorization.rawSha256 = sha256(lifecycleRaw)
  sidecar.lifecycleAuthorization.semanticDigest = canonicalDigest(lifecycle)
  sidecar.target = requirement.target
  sidecar.scope = requirement.scope
  writeJson(sidecarPath, sidecar)
}

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('repair remediation authorization bridge', () => {
  it('derives eligibility from the immutable predecessor defect and mutually bound artifacts', () => {
    const { root } = fixture()
    const result = remediationBridgeErrors({
      projectRoot: root,
      taskId,
      actorId: 'codex',
      role: 'implementation-owner',
    })
    expect(result.valid, result.errors.join('\n')).toBe(true)
    expect(result.lifecycleAuthorization?.artifactType).toBe('sop-authorization-v2')
    expect(result.sidecar?.artifactType).toBe('engineering-governance-remediation-authorization-v1')
  })

  it('requires both artifacts exactly once in the same CANDIDATE event', () => {
    const { root } = fixture()
    const initial = remediationBridgeErrors({ projectRoot: root, taskId, actorId: 'codex', role: 'implementation-owner' })
    const lifecycleRef = {
      kind: `authorization:${initial.lifecycleAuthorization?.requirementId}`,
      path: relative(root, initial.lifecycleAuthorizationPath!),
      sha256: initial.lifecycleAuthorizationRawSha256!,
    }
    const sidecarRef = {
      kind: 'remediation-authorization',
      path: relative(root, initial.sidecarPath!),
      sha256: initial.sidecarRawSha256!,
    }
    const event = { to: 'CANDIDATE', artifactRefs: [lifecycleRef, sidecarRef] } as any
    expect(remediationBridgeErrors({ projectRoot: root, taskId, actorId: 'codex', role: 'implementation-owner', ledgerEvents: [event], requireConsumption: true }).valid).toBe(true)
    const duplicated = remediationBridgeErrors({ projectRoot: root, taskId, actorId: 'codex', role: 'implementation-owner', ledgerEvents: [event, event], requireConsumption: true })
    expect(duplicated.errors).toContain('ACCOUNTABILITY_LIFECYCLE_AUTHORIZATION_CONSUMPTION_INVALID:2')
    expect(duplicated.errors).toContain('ACCOUNTABILITY_REMEDIATION_SIDECAR_CONSUMPTION_INVALID:2')
  })

  it('rejects forged lifecycle digests and reviewer substitutions', () => {
    const { root, taskRoot } = fixture()
    const sidecarPath = join(taskRoot, 'remediation-authorization.json')
    const sidecar = JSON.parse(readFileSync(sidecarPath, 'utf8')) as Record<string, any>
    sidecar.lifecycleAuthorization.rawSha256 = '0'.repeat(64)
    sidecar.contractReviewerId = 'independent-implementation-reviewer-fix1'
    writeJson(sidecarPath, sidecar)
    const result = remediationBridgeErrors({ projectRoot: root, taskId, actorId: 'codex', role: 'implementation-owner' })
    expect(result.valid).toBe(false)
    expect(result.errors).toContain('ACCOUNTABILITY_REMEDIATION_SIDECAR_BINDING_INVALID')
    expect(result.errors).toContain('ACCOUNTABILITY_REMEDIATION_ROLE_BINDING_INVALID')
  })

  it('does not grant an exception from an action string without defect authority', () => {
    const contract = parse(readFileSync(join(fixtureRoot, 'tasks', taskId, 'contract.yaml'), 'utf8')) as Record<string, any>
    contract.authorityInputs = contract.authorityInputs.filter((path: string) => !path.endsWith('/contract-defect.yaml'))
    expect(isRemediationBridgeContract(contract)).toBe(false)
  })

  it('rejects a structurally self-consistent copied predecessor that is not the bootstrap-frozen repair authority', () => {
    const { root, taskRoot } = fixture()
    forgeCopiedPredecessor(root, taskRoot)
    const result = remediationBridgeErrors({ projectRoot: root, taskId, actorId: 'codex', role: 'implementation-owner' })
    expect(result.valid).toBe(false)
    expect(result.errors).toContain('ACCOUNTABILITY_PREDECESSOR_BOOTSTRAP_BINDING_INVALID')
  })

  it('keeps historical and bridge authorization shapes exact and non-overlapping', () => {
    const historical = JSON.parse(readFileSync(join(fixtureRoot, 'tasks', predecessorTaskId, 'authorizations', 'AUTH-EG21-BETA1-FIX1-REMEDIATION.json'), 'utf8'))
    const bridge = JSON.parse(readFileSync(join(fixtureRoot, 'tasks', taskId, 'remediation-authorization.json'), 'utf8'))
    expect(validateDocument('authorization', historical)).toEqual({ valid: true, errors: [] })
    expect(validateDocument('authorization', bridge)).toEqual({ valid: true, errors: [] })
    expect(validateDocument('authorization', { ...bridge, unexpected: true }).valid).toBe(false)
    expect(validateDocument('authorization', { ...historical, lifecycleAuthorization: {} }).valid).toBe(false)
  })
})
