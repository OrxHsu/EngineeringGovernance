import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'

import { parse } from 'yaml'

import { remediationBridgeErrors } from '../dist/accountability/enforce.js'
import { deriveAccountabilityStatus } from '../dist/accountability/derive.js'
import { readActorRegistry } from '../dist/accountability/registry.js'
import { canonicalDigest } from '../dist/model/digest.js'
import { validateDocument } from '../dist/policy/load.js'
import { validateHardenedTaskContract } from '../dist/policy/task-contract.js'
import { readTaskLedger } from '../dist/state/ledger.js'

const taskIdIndex = process.argv.indexOf('--task-id')
const taskId = taskIdIndex >= 0 ? process.argv[taskIdIndex + 1] : undefined
const projectRoot = realpathSync(resolve(new URL('..', import.meta.url).pathname))

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function parsedSource(path, raw) {
  if (path.endsWith('.jsonl')) return raw.toString('utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
  if (path.endsWith('.txt')) return raw.toString('utf8')
  return parse(raw.toString('utf8'))
}

function safeFile(inputPath) {
  const unresolved = isAbsolute(inputPath) ? resolve(inputPath) : resolve(projectRoot, inputPath)
  if (!existsSync(unresolved) || lstatSync(unresolved).isSymbolicLink() || !lstatSync(unresolved).isFile()) throw new Error('unsafe')
  const canonicalPath = realpathSync(unresolved)
  if (canonicalPath !== unresolved) throw new Error('noncanonical')
  return { path: canonicalPath, raw: readFileSync(canonicalPath) }
}

function fail() {
  process.stderr.write('ACCOUNTABILITY_BOOTSTRAP_INVALID\n')
  process.exitCode = 1
}

function sourceKind(path) {
  if (path.endsWith('/contract.yaml')) return 'contract'
  if (path.endsWith('/contract-review.yaml')) return 'review'
  if (path.endsWith('/contract-defect.yaml')) return 'defect'
  if (path.endsWith('/ledger.jsonl')) return 'ledger'
  if (path.endsWith('/pasted-text.txt')) return 'report'
  return undefined
}

try {
  if (typeof taskId !== 'string' || !/^[a-z0-9][a-z0-9._-]*$/.test(taskId)) throw new Error('task')
  const taskRoot = join(projectRoot, '.delivery', 'tasks', taskId)
  const contractFile = safeFile(join(taskRoot, 'contract.yaml'))
  const contract = parse(contractFile.raw.toString('utf8'))
  const contractValidation = validateHardenedTaskContract(contract)
  if (!contractValidation.valid || contract.taskId !== taskId) throw new Error('contract')
  const ledger = readTaskLedger({
    projectRoot,
    taskId,
    contractDigest: contract.contractDigest,
    contractSha256: sha256(contractFile.raw),
    implementationOwner: contract.implementationOwner,
  })
  if (!ledger.valid || ledger.currentState === undefined) throw new Error('ledger')

  const consumedState = ledger.events.some((event) => ['CANDIDATE', 'ACCEPTED', 'REPAIR_REQUIRED', 'CLOSED'].includes(event.to))
  const bridge = remediationBridgeErrors({
    projectRoot,
    taskId,
    actorId: contract.implementationOwner,
    role: 'implementation-owner',
    enforceExpiry: true,
    ledgerEvents: ledger.events,
    requireConsumption: consumedState,
  })
  if (!bridge.applicable || !bridge.valid || bridge.sidecar === undefined || bridge.lifecycleAuthorization === undefined) throw new Error('bridge')

  const lifecycleRelativePath = relative(projectRoot, bridge.lifecycleAuthorizationPath)
  const sidecarRelativePath = relative(projectRoot, bridge.sidecarPath)
  const allReferences = ledger.events.flatMap((event) => event.artifactRefs)
  const lifecycleOccurrences = allReferences.filter((reference) => (
    reference.kind === `authorization:${bridge.lifecycleAuthorization.requirementId}`
    && reference.path === lifecycleRelativePath
    && reference.sha256 === bridge.lifecycleAuthorizationRawSha256
  )).length
  const sidecarOccurrences = allReferences.filter((reference) => (
    reference.kind === 'remediation-authorization'
    && reference.path === sidecarRelativePath
    && reference.sha256 === bridge.sidecarRawSha256
  )).length
  if (!consumedState && (lifecycleOccurrences !== 0 || sidecarOccurrences !== 0)) throw new Error('premature-consumption')

  const bootstrapFile = safeFile(join(taskRoot, 'accountability-bootstrap.yaml'))
  const bootstrap = parse(bootstrapFile.raw.toString('utf8'))
  const bootstrapSchema = validateDocument('accountability-bootstrap', bootstrap)
  if (!bootstrapSchema.valid || bootstrap.taskId !== taskId || bootstrap.policyVersion !== 'strict-v1') throw new Error('bootstrap')

  const expectedSourcePaths = (contract.authorityInputs ?? [])
    .filter((path) => typeof path === 'string' && sourceKind(path) !== undefined)
    .sort()
  const actualSourcePaths = (bootstrap.sources ?? []).map((source) => source.path).sort()
  if (new Set(actualSourcePaths).size !== actualSourcePaths.length || JSON.stringify(actualSourcePaths) !== JSON.stringify(expectedSourcePaths)) throw new Error('source-set')
  if (!(bootstrap.sources ?? []).every((source, index) => source.id === `S-${String(index + 1).padStart(3, '0')}`)) throw new Error('source-order')
  for (const source of bootstrap.sources ?? []) {
    if (source.kind !== sourceKind(source.path)) throw new Error(`source-kind:${source.id}`)
    const file = safeFile(source.path)
    if (sha256(file.raw) !== source.rawSha256 || canonicalDigest(parsedSource(file.path, file.raw)) !== source.semanticDigest) throw new Error(`source:${source.id}`)
  }

  if (
    !Array.isArray(bootstrap.findings)
    || bootstrap.findings.length !== 1
    || bootstrap.findings[0]?.findingId !== 'CR-001'
    || bootstrap.findings[0]?.responsibleActorId !== 'codex'
    || bootstrap.findings[0]?.scoreDelta !== 8
  ) throw new Error('findings')
  const codex = (bootstrap.actors ?? []).find((actor) => actor.actorId === 'codex')
  const reviewer = (bootstrap.actors ?? []).find((actor) => actor.actorId === 'independent-contract-reviewer')
  if (!codex || codex.lifetimePenaltyScore !== 20 || codex.activePenaltyScore !== 20 || codex.standing !== 'SUSPENDED') throw new Error('codex')
  if (!reviewer || reviewer.lifetimePenaltyScore !== 8 || reviewer.activePenaltyScore !== 8 || reviewer.standing !== 'PROBATION') throw new Error('reviewer')
  const registry = readActorRegistry(projectRoot)
  if (registry.actors.length !== bootstrap.actors.length) throw new Error('registry-set')
  for (const expected of bootstrap.actors) {
    const registered = registry.actors.find((actor) => actor.actorId === expected.actorId)
    const actual = deriveAccountabilityStatus(projectRoot, expected.actorId)
    if (
      !registered
      || !registered.active
      || JSON.stringify(actual.aliases) !== JSON.stringify(expected.aliases)
      || actual.lifetimePenaltyScore !== expected.lifetimePenaltyScore
      || actual.activePenaltyScore !== expected.activePenaltyScore
      || actual.standing !== expected.standing
      || JSON.stringify(actual.permissions) !== JSON.stringify(expected.permissions)
      || JSON.stringify(actual.unresolvedDefectClasses) !== JSON.stringify(expected.unresolvedDefectClasses)
    ) throw new Error(`derived-actor:${expected.actorId}`)
  }

  const exception = bootstrap.remediationException
  if (
    !exception
    || exception.taskId !== taskId
    || exception.lifecycleAuthorizationPath !== lifecycleRelativePath
    || exception.lifecycleAuthorizationRawSha256 !== bridge.lifecycleAuthorizationRawSha256
    || exception.lifecycleAuthorizationSemanticDigest !== bridge.lifecycleAuthorizationSemanticDigest
    || exception.sidecarPath !== sidecarRelativePath
    || exception.sidecarRawSha256 !== bridge.sidecarRawSha256
    || exception.sidecarSemanticDigest !== bridge.sidecarSemanticDigest
    || exception.action !== bridge.sidecar.action
    || exception.supervisorId !== bridge.sidecar.supervisorId
    || exception.contractReviewerId !== bridge.sidecar.contractReviewerId
    || exception.implementationReviewerId !== bridge.sidecar.implementationReviewerId
    || exception.issuedAt !== bridge.sidecar.issuedAt
    || exception.expiresAt !== bridge.sidecar.expiresAt
    || exception.consumeOnce !== true
  ) throw new Error('exception')

  process.stdout.write(JSON.stringify({
    valid: true,
    policyVersion: 'strict-v1',
    codex: { score: 20, standing: 'SUSPENDED' },
    'independent-contract-reviewer': { score: 8, standing: 'PROBATION' },
    remediationTask: taskId,
  }) + '\n')
} catch {
  fail()
}
