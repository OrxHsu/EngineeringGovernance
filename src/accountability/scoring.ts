import {
  scoreForFinding,
  standingForScore,
  type FindingClassification,
  type FindingCulpability,
  type FindingSeverity,
  type ScoreBreakdown,
  type Standing,
} from './policy.js'

export interface ScoringFinding {
  severity: FindingSeverity
  defectClass: string
  classification?: FindingClassification
  culpability?: FindingCulpability
}

export interface ActorHistory {
  findings: Array<{ defectClass: string }>
}

export interface PenaltyCalculation extends ScoreBreakdown {
  baseScore: number
  repeatPenalty: number
  totalDelta: number
}

export function calculatePenalty(finding: ScoringFinding, history: ActorHistory): PenaltyCalculation {
  const counts = new Map<string, number>()
  for (const prior of history.findings) {
    const normalized = prior.defectClass.trim().normalize('NFKC').toLowerCase()
      .replace(/[\s_]+/gu, '-')
      .replace(/[^a-z0-9-]/gu, '')
      .replace(/-+/gu, '-')
      .replace(/^-|-$/gu, '')
    counts.set(normalized, (counts.get(normalized) ?? 0) + 1)
  }
  const score = scoreForFinding(
    finding.severity,
    finding.defectClass,
    counts,
    finding.classification ?? 'newly_discovered_defect',
    finding.culpability ?? 'culpable',
  )
  return {
    ...score,
    baseScore: score.base,
    repeatPenalty: score.repeatSurcharge,
    totalDelta: score.delta,
  }
}

export function deriveStanding(activeScore: number, forcedSuspended = false): Standing {
  return standingForScore(activeScore, forcedSuspended)
}
