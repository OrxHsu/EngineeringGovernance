import { inspectCleanTask, type CleanTaskChecks } from '../accountability/clean-task.js'

export function verifyCleanTask(projectRoot: string, taskId: string): CleanTaskChecks & { valid: boolean } {
  const result = inspectCleanTask(projectRoot, taskId)
  return { ...result, valid: result.isClean }
}
