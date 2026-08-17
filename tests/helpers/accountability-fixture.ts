import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { parse, stringify } from 'yaml'

import { canonicalDigest } from '../../src/model/digest.js'

const predecessorTaskId = 'global-sop-2-1-beta-1-fix-1-repair-3'
export const ACCOUNTABILITY_FIXTURE_ROOT = join(process.cwd(), 'tests/fixtures/accountability')

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

function rewriteRoot(value: unknown, from: string, to: string): unknown {
  if (typeof value === 'string') return value
    .replaceAll(from, to)
    .replaceAll('/__RELEASE_PROJECT_ROOT__', to)
    .replaceAll('/__CODEX_ATTACHMENT__', join(to, '.delivery', 'attachments'))
  if (Array.isArray(value)) return value.map((item) => rewriteRoot(item, from, to))
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, rewriteRoot(entry, from, to)]))
}

function runtimeExecutable(source: string): string {
  const candidate = source.includes('pnpm')
    ? execFileSync('which', ['pnpm'], { encoding: 'utf8' }).trim()
    : process.execPath
  return realpathSync(candidate)
}

export function rebindRuntimeCommands(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => rebindRuntimeCommands(item))
  if (value === null || typeof value !== 'object') return value
  const record = Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, rebindRuntimeCommands(entry)]),
  ) as Record<string, any>
  if (typeof record.executable === 'string' && record.executable.includes('/')) {
    record.executable = runtimeExecutable(record.executable)
    if ('executableSha256' in record) record.executableSha256 = sha256(readFileSync(record.executable))
  }
  if (record.environment !== null && typeof record.environment === 'object' && 'PATH' in record.environment) {
    record.environment.PATH = process.env.PATH ?? ''
  }
  return record
}

function semantic(path: string, raw: Buffer): string {
  if (path.endsWith('.jsonl')) return canonicalDigest(raw.toString('utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)))
  if (['.yaml', '.yml', '.json'].some((extension) => path.endsWith(extension))) {
    return canonicalDigest(parse(raw.toString('utf8')))
  }
  return canonicalDigest(raw.toString('utf8'))
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

function rebindTaskContract(root: string, originalRoot: string, taskId: string): {
  contract: Record<string, any>
  contractText: string
  reviewText: string
} {
  const taskRoot = join(root, '.delivery', 'tasks', taskId)
  const contractPath = join(taskRoot, 'contract.yaml')
  const contract = rebindRuntimeCommands(
    rewriteRoot(parse(readFileSync(contractPath, 'utf8')), originalRoot, root),
  ) as Record<string, any>
  const { contractDigest: _oldContractDigest, ...unsignedContract } = contract
  contract.contractDigest = canonicalDigest(unsignedContract)
  const contractText = stringify(contract, { lineWidth: 0 })
  writeFileSync(contractPath, contractText)

  const reviewPath = join(taskRoot, 'contract-review.yaml')
  const review = rewriteRoot(parse(readFileSync(reviewPath, 'utf8')), originalRoot, root) as Record<string, any>
  review.reviewId = `crv-${taskId}-${contract.contractDigest}`
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

  const artifactHashes = new Map<string, string>([
    [`.delivery/tasks/${taskId}/contract.yaml`, sha256(contractText)],
    [`.delivery/tasks/${taskId}/contract-review.yaml`, sha256(reviewText)],
  ])
  const defectPath = join(taskRoot, 'contract-defect.yaml')
  if (existsSync(defectPath)) {
    const defect = parse(readFileSync(defectPath, 'utf8')) as Record<string, any>
    defect.authorities.contract.rawSha256 = sha256(contractText)
    defect.authorities.contract.semanticDigest = contract.contractDigest
    defect.authorities.acceptedContractReview.rawSha256 = sha256(reviewText)
    const defectText = stringify(defect, { lineWidth: 0 })
    writeFileSync(defectPath, defectText)
    artifactHashes.set(`.delivery/tasks/${taskId}/contract-defect.yaml`, sha256(defectText))
  }

  const ledgerPath = join(taskRoot, 'ledger.jsonl')
  rewriteChain(ledgerPath, (event) => {
    event.contractDigest = contract.contractDigest
    for (const reference of event.artifactRefs ?? []) {
      const hash = artifactHashes.get(reference.path)
      if (hash !== undefined) reference.sha256 = hash
    }
  }, null)
  return { contract, contractText, reviewText }
}

export function rebindAccountabilityFixture(root: string, originalRoot: string): void {
  cpSync(join(ACCOUNTABILITY_FIXTURE_ROOT, 'attachments'), join(root, '.delivery', 'attachments'), { recursive: true })
  const fix1TaskId = 'global-sop-2-1-beta-1-fix-1'
  if (existsSync(join(root, '.delivery', 'tasks', fix1TaskId, 'contract.yaml'))) {
    rebindTaskContract(root, originalRoot, fix1TaskId)
  }
  const taskRoot = join(root, '.delivery', 'tasks', predecessorTaskId)
  const predecessor = rebindTaskContract(root, originalRoot, predecessorTaskId)
  const contract = predecessor.contract
  const contractText = predecessor.contractText
  const reviewText = predecessor.reviewText
  const contractPath = join(taskRoot, 'contract.yaml')

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
    if (existsSync(path)) rewriteChain(path, (event) => {
      event.source = rewriteRoot(event.source, originalRoot, root)
      if (event.source && typeof event.source.artifactPath === 'string') {
        const sourcePath = resolve(root, event.source.artifactPath)
        if (existsSync(sourcePath)) {
          const raw = readFileSync(sourcePath)
          event.source.rawSha256 = sha256(raw)
          event.source.semanticDigest = semantic(sourcePath, raw)
        }
      }
      if (event.incident === undefined) {
        event.authorization = authorizationReference
        return
      }
      event.incident = rewriteRoot(event.incident, originalRoot, root)
      event.authorization = 'none'
      event.source.rawSha256 = sha256(`${JSON.stringify(event.incident, null, 2)}\n`)
      event.source.semanticDigest = canonicalDigest(event.incident)
    }, genesis)
  }

  const taskIds = [predecessorTaskId, 'global-sop-2-1-beta-1-fix-1-repair-4']
  for (const taskId of taskIds) {
    const bootstrapPath = join(root, '.delivery', 'tasks', taskId, 'accountability-bootstrap.yaml')
    if (!existsSync(bootstrapPath)) continue
    const bootstrap = parse(readFileSync(bootstrapPath, 'utf8')) as Record<string, any>
    for (const source of bootstrap.sources ?? []) {
      source.path = rewriteRoot(source.path, originalRoot, root)
      const path = resolve(root, source.path)
      if (!existsSync(path)) continue
      const raw = readFileSync(path)
      source.rawSha256 = sha256(raw)
      source.semanticDigest = semantic(path, raw)
    }
    writeFileSync(bootstrapPath, stringify(bootstrap, { lineWidth: 0 }))
  }
}
