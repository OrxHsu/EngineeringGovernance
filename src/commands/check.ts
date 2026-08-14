import type { ValidationResult } from '../model/types.js'
import {
  validateProjectTaskGraph,
  type TaskGraphTaskReport,
} from '../project/task-graph.js'
import { verifyAdoptedProject } from './adopt.js'

export interface ProjectCheckResult extends ValidationResult {
  taskGraph?: { tasks: TaskGraphTaskReport[] }
}

export function checkProject(project: string): ProjectCheckResult {
  const adoption = verifyAdoptedProject(project)
  let graph: ReturnType<typeof validateProjectTaskGraph>
  try {
    graph = validateProjectTaskGraph(project)
  } catch {
    graph = { valid: false, errors: ['TASK_GRAPH_UNREADABLE'], tasks: [] }
  }
  const errors = [...new Set([...adoption.errors, ...graph.errors])].sort()
  return {
    valid: errors.length === 0,
    errors,
    ...(graph.tasks.length === 0 ? {} : { taskGraph: { tasks: graph.tasks } }),
  }
}
