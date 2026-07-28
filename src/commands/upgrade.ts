import { planAdoption, type AdoptionPlan } from './adopt.js'

export function planUpgrade(project: string): AdoptionPlan {
  return planAdoption(project)
}
