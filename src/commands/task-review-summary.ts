import { join, resolve } from 'node:path'
import { realpathSync } from 'node:fs'

import { verifyContractReadinessArtifact } from '../state/contract-readiness.js'

export interface ReviewSummary {
  schemaVersion: 1
  artifactType: 'engineering-governance-review-summary-v1'
  taskId: string
  decision: 'ACCEPTED' | 'REPAIR_REQUIRED'
  headline: string
  keyPoints: string[]
  findings: Array<{ id: string; severity: string; observation: string; requiredChange: string }>
  selfReviewStatus: string
  confirmationRequired: true
  nextAction: string
}

function dimensionName(value: string): string {
  return value.replaceAll('_', ' ')
}

export function generateReviewSummary(projectRootInput: string, taskId: string): ReviewSummary {
  const projectRoot = realpathSync(resolve(projectRootInput))
  const reviewPath = join(projectRoot, '.delivery', 'tasks', taskId, 'contract-review.yaml')
  const verification = verifyContractReadinessArtifact(projectRoot, taskId, reviewPath)
  if (!verification.valid || verification.review === undefined || verification.contract === undefined) {
    throw new Error(`REVIEW_SUMMARY_REVIEW_INVALID:${verification.errors.join(',')}`)
  }
  const review = verification.review
  const contract = verification.contract
  const blockers = review.findings.filter((finding) => finding.severity === 'BLOCKER')
  const assisted = review.assistedReview
  const keyPoints = assisted === undefined
    ? Object.keys(review.checklist).map((key) => `PASS: ${dimensionName(key)}`)
    : Object.entries(assisted.checklist).map(([key, item]) => (
      `${item.status}: ${dimensionName(key)} - ${item.observation}`
    ))
  const selfReview = contract.selfReview
  const concernNames = selfReview?.dimensions
    .filter((dimension) => dimension.status === 'CONCERN')
    .map((dimension) => dimension.name) ?? []
  const accepted = review.decision === 'ACCEPTED'
  return {
    schemaVersion: 1,
    artifactType: 'engineering-governance-review-summary-v1',
    taskId,
    decision: review.decision,
    headline: accepted
      ? 'Contract review accepted; user confirmation is required before implementation starts.'
      : `${blockers.length} blocker(s) found; contract repair is required.`,
    keyPoints,
    findings: review.findings.map((finding) => ({
      id: finding.id,
      severity: finding.severity,
      observation: finding.observation,
      requiredChange: finding.requiredChange,
    })),
    selfReviewStatus: selfReview === undefined
      ? 'No advisory self-review was attached.'
      : concernNames.length === 0
        ? 'Author self-review reported no concerns.'
        : `Author self-review reported concerns: ${concernNames.join(', ')}.`,
    confirmationRequired: true,
    nextAction: accepted
      ? 'After user confirmation, prepare the owner transition from DEFINED to IN_PROGRESS bound to this accepted review.'
      : 'Return all findings to the contract author, repair the contract, and obtain a new exact-contract independent review.',
  }
}

export function formatReviewSummary(summary: ReviewSummary): string {
  const findings = summary.findings.length === 0
    ? ['  None.']
    : summary.findings.map((finding) => `  ${finding.id} [${finding.severity}] ${finding.observation}`)
  return [
    `[${summary.decision}] ${summary.taskId}`,
    summary.headline,
    '',
    'Key points:',
    ...summary.keyPoints.map((point) => `  ${point}`),
    '',
    summary.selfReviewStatus,
    '',
    'Findings:',
    ...findings,
    '',
    'Next action:',
    `  ${summary.nextAction}`,
  ].join('\n')
}
