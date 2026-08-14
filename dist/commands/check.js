import { validateProjectTaskGraph, } from '../project/task-graph.js';
import { verifyAdoptedProject } from './adopt.js';
export function checkProject(project) {
    const adoption = verifyAdoptedProject(project);
    let graph;
    try {
        graph = validateProjectTaskGraph(project);
    }
    catch {
        graph = { valid: false, errors: ['TASK_GRAPH_UNREADABLE'], tasks: [] };
    }
    const errors = [...new Set([...adoption.errors, ...graph.errors])].sort();
    return {
        valid: errors.length === 0,
        errors,
        ...(graph.tasks.length === 0 ? {} : { taskGraph: { tasks: graph.tasks } }),
    };
}
