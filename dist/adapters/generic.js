import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { renderCoreBlock } from './render.js';
export function textDigest(text) {
    return createHash('sha256').update(text).digest('hex');
}
export function planGeneratedFile(path, after) {
    if (!existsSync(path))
        return [{ path, beforeDigest: null, after }];
    const before = readFileSync(path, 'utf8');
    if (before === after)
        return [];
    throw new Error(`GENERATED_TARGET_CONFLICT:${path}`);
}
export function generatedVerification(path, expected) {
    const valid = existsSync(path) && readFileSync(path, 'utf8') === expected;
    return { valid, errors: valid ? [] : [`GENERATED_TARGET_MISSING_OR_DRIFTED:${path}`] };
}
export function planGenericAdapter(options) {
    const projectRoot = resolve(options.projectRoot);
    const owningSource = join(projectRoot, 'AGENTS.md');
    if (existsSync(owningSource)) {
        return {
            tool: 'generic',
            owningSource,
            generatedTargets: [],
            plannedWrites: [],
            verification: { valid: true, errors: [] },
            removal: { strategy: 'none', targets: [] },
        };
    }
    const content = renderCoreBlock(options.identity);
    return {
        tool: 'generic',
        owningSource,
        generatedTargets: [owningSource],
        plannedWrites: planGeneratedFile(owningSource, content),
        verification: generatedVerification(owningSource, content),
        removal: { strategy: 'generated-file', targets: [owningSource] },
    };
}
