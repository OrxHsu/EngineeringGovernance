import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { parse, stringify } from 'yaml'

import { canonicalDigest } from '../../src/model/digest.js'

const predecessorTaskId = 'global-sop-2-1-beta-1-fix-1-repair-3'

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

function rewriteRoot(value: unknown, from: string, to: string): unknown {
  if (typeof value === 'string') return value.replaceAll(from, to)
  if (Array.isArray(value)) return value.map((item) => rewriteRoot(item, from, to))
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, rewriteRoot(entry, from, to)]))
}

function semantic(path: string, raw: Buffer): string {
  if (path.endsWith('.jsonl')) return canonicalDigest(raw.toString('utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)))
  return canonicalDigest(parse(raw.toString('utf8')))
}

function rewriteChain(path: string, update: (event: Record<string, any>) => void, genesis: string | null): void {
  const events = readFileSync(path, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Record<string, any>)
  let prior = genesis
  for (const event of events) {
    update(event)
    if ('priorEventDigest' in event) event.priorEventDigest = prior
    if ('previousEventDigest' in event) event.previousEventDigest = prior
    const { eventDigest: _old, ...unsigned } = event
    event.eventDigest = canonicalDigest(unsigned)
    prior = event.eventDigest
  }
  writeFileSync(path, `${events.map((event) => JSON.stringify(event)).join('\n')}\n`)
}

export function rebindAccountabilityFixture(root: string, originalRoot: string): void {
  const taskRoot = join(root, '.delivery', 'tasks', predecessorTaskId)
  const contractPath = join(taskRoot, 'contract.yaml')
  const contract = rewriteRoot(parse(readFileSync(contractPath, 'utf8')), originalRoot, root) as Record<string, any>
  const { contractDigest: _oldContractDigest, ...unsignedContract } = contract
  contract.contractDigest = canonicalDigest(unsignedContract)
  const contractText = stringify(contract, { lineWidth: 0 })
  writeFileSync(contractPath, contractText)

  const reviewPath = join(taskRoot, 'contract-review.yaml')
  const review = rewriteRoot(parse(readFileSync(reviewPath, 'utf8')), originalRoot, root) as Record<string, any>
  review.reviewId = `crv-${predecessorTaskId}-${contract.contractDigest}`
  review.contract.path = contractPath
  review.contract.rawSha256 = sha256(contractText)
  review.contract.digest = contract.contractDigest
  for (const section of [review.checklist, review.r3Requirements]) {
    for (const item of Object.values(section ?? {}) as Array<Record<string, any>>) {
      for (const ref of item.evidenceRefs ?? []) {
        if (ref.kind === 'contract' && String(ref.path).endsWith('/contract.yaml')) {
          ref.sha256 = sha256(contractText)
          ref.digest = canonicalDigest(contract)
        }
      }
    }
  }
  const reviewText = stringify(review, { lineWidth: 0 })
  writeFileSync(reviewPath, reviewText)

  const requirement = contract.authorizationRequirements[0]
  const authorizationPath = join(taskRoot, 'authorizations', `${requirement.id}.json`)
  const authorization = rewriteRoot(JSON.parse(readFileSync(authorizationPath, 'utf8')), originalRoot, root) as Record<string, any>
  authorization.contract.path = contractPath
  authorization.contract.rawSha256 = sha256(contractText)
  authorization.contract.semanticDigest = contract.contractDigest
  authorization.target = requirement.target
  authorization.scope = requirement.scope
  writeFileSync(authorizationPath, `${JSON.stringify(authorization, null, 2)}\n`)
  const authorizationRaw = readFileSync(authorizationPath)

  const defectPath = join(taskRoot, 'contract-defect.yaml')
  const defect = parse(readFileSync(defectPath, 'utf8')) as Record<string, any>
  defect.authorities.contract.rawSha256 = sha256(contractText)
  defect.authorities.contract.semanticDigest = contract.contractDigest
  defect.authorities.acceptedContractReview.rawSha256 = sha256(reviewText)
  const defectText = stringify(defect, { lineWidth: 0 })
  writeFileSync(defectPath, defectText)

  const ledgerPath = join(taskRoot, 'ledger.jsonl')
  rewriteChain(ledgerPath, (event) => {
    event.contractDigest = contract.contractDigest
    for (const reference of event.artifactRefs ?? []) {
      if (reference.path === `.delivery/tasks/${predecessorTaskId}/contract.yaml`) reference.sha256 = sha256(contractText)
      if (reference.path === `.delivery/tasks/${predecessorTaskId}/contract-review.yaml`) reference.sha256 = sha256(reviewText)
      if (reference.path === `.delivery/tasks/${predecessorTaskId}/contract-defect.yaml`) reference.sha256 = sha256(defectText)
      if (reference.path === `.delivery/tasks/${predecessorTaskId}/authorizations/${requirement.id}.json`) reference.sha256 = sha256(authorizationRaw)
    }
  }, null)

  const predecessorBootstrapPath = join(taskRoot, 'accountability-bootstrap.yaml')
  const predecessorBootstrap = rewriteRoot(parse(readFileSync(predecessorBootstrapPath, 'utf8')), originalRoot, root) as Record<string, any>
  predecessorBootstrap.remediationException.authorizationRawSha256 = sha256(authorizationRaw)
  predecessorBootstrap.remediationException.authorizationSemanticDigest = canonicalDigest(authorization)
  writeFileSync(predecessorBootstrapPath, stringify(predecessorBootstrap, { lineWidth: 0 }))

  const authorizationReference = {
    authorizationId: authorization.authorizationId,
    path: `.delivery/tasks/${predecessorTaskId}/authorizations/${requirement.id}.json`,
    rawSha256: sha256(authorizationRaw),
    semanticDigest: canonicalDigest(authorization),
  }
  const genesis = 'c6043b1735ad12fa345400d16a9d34c722cea5952821d5e8f00023841d5a9071'
  for (const name of ['actors.jsonl', 'events.jsonl']) {
    const path = join(root, '.delivery', 'accountability', name)
    if (existsSync(path)) rewriteChain(path, (event) => { event.authorization = authorizationReference }, genesis)
  }

  const taskIds = [predecessorTaskId, 'global-sop-2-1-beta-1-fix-1-repair-4']
  for (const taskId of taskIds) {
    const bootstrapPath = join(root, '.delivery', 'tasks', taskId, 'accountability-bootstrap.yaml')
    if (!existsSync(bootstrapPath)) continue
    const bootstrap = parse(readFileSync(bootstrapPath, 'utf8')) as Record<string, any>
    for (const source of bootstrap.sources ?? []) {
      if (!String(source.path).startsWith(`.delivery/tasks/${predecessorTaskId}/`)) continue
      const path = join(root, source.path)
      const raw = readFileSync(path)
      source.rawSha256 = sha256(raw)
      source.semanticDigest = semantic(path, raw)
    }
    writeFileSync(bootstrapPath, stringify(bootstrap, { lineWidth: 0 }))
  }
}
