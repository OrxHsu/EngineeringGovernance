import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { preflightTaskInput, verifyPreflightPlan } from '../accountability/preflight.js';
export function runTaskPreflight(options) {
    const result = preflightTaskInput(options.projectRoot, options.inputPath);
    if (!result.valid || options.expectedPlan === undefined)
        return result;
    return verifyPreflightPlan(options.expectedPlan, options.projectRoot, options.inputPath);
}
export function readPreflightDocument(path) {
    return parse(readFileSync(path, 'utf8'));
}
