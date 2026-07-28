import type { ValidationResult } from '../model/types.js'
import { verifyAdoptedProject } from './adopt.js'

export function checkProject(project: string): ValidationResult {
  return verifyAdoptedProject(project)
}
