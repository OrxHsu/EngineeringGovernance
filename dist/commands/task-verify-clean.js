import { inspectCleanTask } from '../accountability/clean-task.js';
export function verifyCleanTask(projectRoot, taskId) {
    const result = inspectCleanTask(projectRoot, taskId);
    return { ...result, valid: result.isClean };
}
