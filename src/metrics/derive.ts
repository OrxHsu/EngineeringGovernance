import type { Risk } from '../model/types.js'

export interface TaskMetricRecord {
  taskId: string
  risk: Risk
  candidateCount: number
  repairCycles: number
  escapedBlockingDefects: number
  definedAt: string
  acceptedAt: string
  gateFlakes: number
  gateFalsePositives: number
  expiredExceptions: number
  findings: Array<{ defectClass: string; permanentGateId?: string }>
}

export interface WorkflowMetrics {
  firstCandidateAcceptanceRate: number
  repairCyclesPerAcceptedTask: number
  escapedBlockingDefects: number
  gateFlakes: number
  gateFalsePositives: number
  expiredExceptions: number
  medianAcceptanceMillisecondsByRisk: Partial<Record<Risk, number>>
  repeatedDefectClassesConvertedRate: number
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0)
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) return sorted[middle] ?? 0
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
}

export function deriveMetrics(records: TaskMetricRecord[]): WorkflowMetrics {
  const taskCount = records.length
  const durations = new Map<Risk, number[]>()
  const defectClasses = new Map<string, { count: number; converted: boolean }>()

  for (const record of records) {
    const duration = Date.parse(record.acceptedAt) - Date.parse(record.definedAt)
    const riskDurations = durations.get(record.risk) ?? []
    riskDurations.push(duration)
    durations.set(record.risk, riskDurations)

    for (const finding of record.findings) {
      const current = defectClasses.get(finding.defectClass) ?? { count: 0, converted: false }
      current.count += 1
      current.converted ||= finding.permanentGateId !== undefined
      defectClasses.set(finding.defectClass, current)
    }
  }

  const repeated = [...defectClasses.values()].filter((item) => item.count >= 2)
  const medianAcceptanceMillisecondsByRisk: Partial<Record<Risk, number>> = {}
  for (const [risk, values] of durations) medianAcceptanceMillisecondsByRisk[risk] = median(values)

  return {
    firstCandidateAcceptanceRate: taskCount === 0
      ? 0
      : records.filter((record) => record.candidateCount === 1).length / taskCount,
    repairCyclesPerAcceptedTask: taskCount === 0
      ? 0
      : sum(records.map((record) => record.repairCycles)) / taskCount,
    escapedBlockingDefects: sum(records.map((record) => record.escapedBlockingDefects)),
    gateFlakes: sum(records.map((record) => record.gateFlakes)),
    gateFalsePositives: sum(records.map((record) => record.gateFalsePositives)),
    expiredExceptions: sum(records.map((record) => record.expiredExceptions)),
    medianAcceptanceMillisecondsByRisk,
    repeatedDefectClassesConvertedRate: repeated.length === 0
      ? 0
      : repeated.filter((item) => item.converted).length / repeated.length,
  }
}
