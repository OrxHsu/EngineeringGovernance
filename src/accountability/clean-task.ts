import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { parse } from 'yaml'

import { verifyContractReview } from '../commands/task-contract-review-v2.js'
import { verifyHardenedReview } from '../commands/task-review-v2.js'
import type { Risk } from '../model/types.js'
import { implementationOwnersOf } from '../model/ownership.js'
import { validateDocument } from '../policy/load.js'
import { validateHardenedTaskContract } from '../policy/task-contract.js'
import { readTaskLedger } from '../state/ledger.js'

export interface CleanTaskChecks {
  taskId: string
  risk: Risk | null
  contractReviewAccepted: boolean
  implementationReviewAccepted: boolean
  noRepairRequired: boolean
  noImplementationFindings: boolean
  allAcceptanceFirstPass: boolean
  noAuthorizationViolations: boolean
  noEvidenceForgery: boolean
  isClean: boolean
  credit: number
  errors: string[]
}

type Contract = {
  schemaVersion: 2
  taskId: string
  contractDigest: string
  implementationOwner?: string
  implementationOwners?: string[]
  risk: Risk
  acceptance: Array<{ id: string }>
}

function sha256(input: string | Uint8Array): string {
  return createHash('sha256').update(input).digest('hex')
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function safeTaskDirectory(projectRootInput: string, taskId: string): { root: string; directory: string } {
  if (!/^[a-z0-9][a-z0-9._-]*$/u.test(taskId)) throw new Error('CLEAN_TASK_ID_INVALID')
  const root = realpathSync(resolve(projectRootInput))
  const unresolved = join(root, '.delivery', 'tasks', taskId)
  if (!existsSync(unresolved) || lstatSync(unresolved).isSymbolicLink() || !lstatSync(unresolved).isDirectory()) {
    throw new Error('CLEAN_TASK_DIRECTORY_UNSAFE')
  }
  const directory = realpathSync(unresolved)
  if (directory !== unresolved) throw new Error('CLEAN_TASK_DIRECTORY_UNSAFE')
  return { root, directory }
}

function safeFile(path: string, label: string): string {
  if (!existsSync(path) || lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile() || realpathSync(path) !== path) {
    throw new Error(`CLEAN_TASK_${label}_UNSAFE`)
  }
  return path
}

function recoveryCredit(risk: Risk | null): number {
  if (risk === 'R3') return -3
  if (risk === 'R2') return -2
  if (risk === 'R1') return -1
  return 0
}

export function inspectCleanTask(projectRoot: string, taskId: string): CleanTaskChecks {
  const errors: string[] = []
  let directory = ''
  let contract: Contract | undefined
  let contractRaw: Buffer | undefined
  try {
    directory = safeTaskDirectory(projectRoot, taskId).directory
    const path = safeFile(join(directory, 'contract.yaml'), 'CONTRACT')
    contractRaw = readFileSync(path)
    contract = parse(contractRaw.toString('utf8')) as Contract
    const validation = validateHardenedTaskContract(contract)
    if (!validation.valid || contract.taskId !== taskId) errors.push('CLEAN_TASK_CONTRACT_INVALID')
  } catch (error) {
    errors.push(error instanceof Error ? error.message : 'CLEAN_TASK_CONTRACT_INVALID')
  }

  let ledgerValid = false
  let closed = false
  let noRepairRequired = false
  if (contract !== undefined && contractRaw !== undefined) {
    const ledger = readTaskLedger({
      projectRoot,
      taskId,
      contractDigest: contract.contractDigest,
      contractSha256: sha256(contractRaw),
      implementationOwners: implementationOwnersOf(contract),
    })
    ledgerValid = ledger.valid
    closed = ledger.currentState === 'CLOSED'
    const states = ledger.events.map((event) => event.to)
    noRepairRequired = ledger.valid
      && !states.some((state) => ['REPAIR_REQUIRED', 'BLOCKED', 'CANCELLED', 'SUPERSEDED'].includes(state))
      && states.filter((state) => state === 'CANDIDATE').length === 1
      && states.filter((state) => state === 'ACCEPTED').length === 1
      && states.filter((state) => state === 'CLOSED').length === 1
    if (!ledger.valid) errors.push(...ledger.errors.map((error) => `CLEAN_TASK_LEDGER_INVALID:${error}`))
    if (!closed) errors.push(`CLEAN_TASK_NOT_CLOSED:${ledger.currentState ?? 'UNKNOWN'}`)
    if (!noRepairRequired) errors.push('CLEAN_TASK_REPAIR_OR_RETRY_PRESENT')
  }

  let contractReviewAccepted = false
  try {
    const path = safeFile(join(directory, 'contract-review.yaml'), 'CONTRACT_REVIEW')
    const review = parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    const result = verifyContractReview(path)
    contractReviewAccepted = result.valid && review.decision === 'ACCEPTED'
      && Array.isArray(review.findings) && review.findings.length === 0
    if (!contractReviewAccepted) errors.push(...result.errors.map((error) => `CLEAN_TASK_CONTRACT_REVIEW_INVALID:${error}`))
  } catch (error) {
    errors.push(error instanceof Error ? error.message : 'CLEAN_TASK_CONTRACT_REVIEW_INVALID')
  }

  let implementationReviewAccepted = false
  let noImplementationFindings = false
  let verificationTime = new Date(0)
  try {
    const verificationPath = safeFile(join(directory, 'verification.json'), 'VERIFICATION')
    const verification = JSON.parse(readFileSync(verificationPath, 'utf8')) as Record<string, unknown>
    verificationTime = new Date(String(verification.verifiedAt))
    const reviewPath = safeFile(join(directory, 'review.yaml'), 'IMPLEMENTATION_REVIEW')
    const review = parse(readFileSync(reviewPath, 'utf8')) as Record<string, unknown>
    const result = verifyHardenedReview(reviewPath, verificationTime, { mode: 'recorded' })
    implementationReviewAccepted = result.valid && review.decision === 'ACCEPTED'
    noImplementationFindings = Array.isArray(review.findings) && review.findings.length === 0
    if (!implementationReviewAccepted) errors.push(...result.errors.map((error) => `CLEAN_TASK_IMPLEMENTATION_REVIEW_INVALID:${error}`))
    if (!noImplementationFindings) errors.push('CLEAN_TASK_IMPLEMENTATION_FINDINGS_PRESENT')
  } catch (error) {
    errors.push(error instanceof Error ? error.message : 'CLEAN_TASK_IMPLEMENTATION_REVIEW_INVALID')
  }

  let allAcceptanceFirstPass = false
  let evidenceIntegrity = false
  let authorizationIntegrity = false
  try {
    const evidencePath = safeFile(join(directory, 'evidence.json'), 'EVIDENCE')
    const verificationPath = safeFile(join(directory, 'verification.json'), 'VERIFICATION')
    const evidence = JSON.parse(readFileSync(evidencePath, 'utf8')) as Record<string, unknown>
    const verification = JSON.parse(readFileSync(verificationPath, 'utf8')) as Record<string, unknown>
    if (!validateDocument('evidence', evidence).valid || !validateDocument('verification', verification).valid) {
      throw new Error('CLEAN_TASK_EVIDENCE_SCHEMA_INVALID')
    }
    const receipts = Array.isArray(evidence.receipts) ? evidence.receipts.filter(record) : []
    const receiptIds = receipts.map((receipt) => String(receipt.acceptanceId))
    const acceptanceIds = contract?.acceptance.map((acceptance) => acceptance.id) ?? []
    const runId = String(evidence.runId)
    const receiptsValid = receipts.length > 0 && receipts.every((reference) => {
      const path = safeFile(resolve(projectRoot, String(reference.path)), 'RECEIPT')
      const raw = readFileSync(path)
      if (sha256(raw) !== reference.sha256) return false
      const receipt = JSON.parse(raw.toString('utf8')) as Record<string, unknown>
      return validateDocument('execution-receipt', receipt).valid
        && receipt.taskId === taskId
        && receipt.runId === runId
        && receipt.acceptanceId === reference.acceptanceId
        && receipt.exitCode === 0
        && Array.isArray(receipt.policyErrors)
        && receipt.policyErrors.length === 0
    })
    const summary = record(evidence.summary) ? evidence.summary : {}
    const passed = Array.isArray(summary.passedIds) ? summary.passedIds.map(String).sort() : []
    const failed = Array.isArray(summary.failedIds) ? summary.failedIds : []
    allAcceptanceFirstPass = receiptsValid
      && new Set(receiptIds).size === receiptIds.length
      && JSON.stringify([...receiptIds].sort()) === JSON.stringify([...acceptanceIds].sort())
      && JSON.stringify(passed) === JSON.stringify([...acceptanceIds].sort())
      && failed.length === 0
    const verifiedEvidence = record(verification.evidence) ? verification.evidence : {}
    evidenceIntegrity = allAcceptanceFirstPass
      && verifiedEvidence.path === evidencePath
      && verifiedEvidence.sha256 === sha256(readFileSync(evidencePath))
      && verification.decision === 'eligible'
    authorizationIntegrity = ledgerValid && Array.isArray(verification.authorizationTrust)
      && Array.isArray(verification.authorizationArtifacts)
    if (!allAcceptanceFirstPass) errors.push('CLEAN_TASK_ACCEPTANCE_NOT_FIRST_PASS')
    if (!evidenceIntegrity) errors.push('CLEAN_TASK_EVIDENCE_INTEGRITY_INVALID')
    if (!authorizationIntegrity) errors.push('CLEAN_TASK_AUTHORIZATION_INTEGRITY_INVALID')
  } catch (error) {
    errors.push(error instanceof Error ? error.message : 'CLEAN_TASK_EVIDENCE_INVALID')
  }

  const risk = contract?.risk ?? null
  const checks = {
    contractReviewAccepted,
    implementationReviewAccepted,
    noRepairRequired,
    noImplementationFindings,
    allAcceptanceFirstPass,
    noAuthorizationViolations: authorizationIntegrity,
    noEvidenceForgery: evidenceIntegrity,
  }
  const isClean = closed && Object.values(checks).every(Boolean) && risk !== 'R0'
  if (closed && Object.values(checks).every(Boolean) && risk === 'R0') errors.push('CLEAN_TASK_R0_NOT_ELIGIBLE')
  return {
    taskId,
    risk,
    ...checks,
    isClean,
    credit: isClean ? recoveryCredit(risk) : 0,
    errors: [...new Set(errors)].sort(),
  }
}
