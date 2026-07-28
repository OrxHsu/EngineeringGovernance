import type { Risk } from '../model/types.js'

export interface RiskSignals {
  readOnly?: boolean
  localEdit?: boolean
  mutation?: boolean
  classificationComplete?: boolean
  userVisible?: boolean
  crossModule?: boolean
  multiRepository?: boolean
  persistentData?: boolean
  authentication?: boolean
  authorization?: boolean
  privacy?: boolean
  security?: boolean
  migration?: boolean
  destructive?: boolean
  payments?: boolean
  production?: boolean
  deployment?: boolean
  remoteMutation?: boolean
  externalCommunication?: boolean
  restrictedRuntime?: boolean
  projectMinimum?: Risk
}

const rank: Record<Risk, number> = { R0: 0, R1: 1, R2: 2, R3: 3 }

const highRiskSignals: Array<keyof RiskSignals> = [
  'authentication',
  'authorization',
  'privacy',
  'security',
  'migration',
  'destructive',
  'payments',
  'production',
  'deployment',
  'remoteMutation',
  'externalCommunication',
  'restrictedRuntime',
]

const mediumRiskSignals: Array<keyof RiskSignals> = [
  'userVisible',
  'crossModule',
  'multiRepository',
  'persistentData',
]

export function highestRisk(risks: Risk[]): Risk {
  return risks.reduce<Risk>(
    (highest, risk) => rank[risk] > rank[highest] ? risk : highest,
    'R0',
  )
}

export function classifyRisk(signals: RiskSignals): Risk {
  const matches: Risk[] = []

  if (highRiskSignals.some((signal) => signals[signal] === true)) matches.push('R3')
  if (mediumRiskSignals.some((signal) => signals[signal] === true)) matches.push('R2')
  if (signals.mutation === true && signals.classificationComplete !== true) matches.push('R2')
  if (signals.localEdit === true || signals.mutation === true) matches.push('R1')
  if (signals.readOnly === true) matches.push('R0')
  if (signals.projectMinimum) matches.push(signals.projectMinimum)

  return highestRisk(matches)
}
