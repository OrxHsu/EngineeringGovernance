import { planAdoption, type AdoptionPlan } from './adopt.js'

export function planUpgrade(project: string, options: { runnerBundlePath?: string } = {}): AdoptionPlan {
  return planAdoption(project, { ...options, allowExpectedManagedDirty: true })
}
