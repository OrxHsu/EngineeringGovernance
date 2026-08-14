import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { generatedVerification, planGeneratedFile } from './generic.js';
import { renderCoreBlock } from './render.js';
const template = readFileSync(new URL('../../adapters/cursor/rule.mdc', import.meta.url), 'utf8');
function renderCursorRule(identity) {
    const rendered = template.replace('{{CORE_BLOCK}}', renderCoreBlock(identity).trimEnd());
    if (rendered.includes('{{'))
        throw new Error('CURSOR_TEMPLATE_TOKEN_UNRESOLVED');
    return rendered.endsWith('\n') ? rendered : `${rendered}\n`;
}
export function planCursorAdapter(options) {
    const projectRoot = resolve(options.projectRoot);
    const owningSource = join(projectRoot, 'AGENTS.md');
    if (!existsSync(owningSource))
        throw new Error('CURSOR_AGENTS_AUTHORITY_MISSING');
    if (!options.compatibilityEnabled) {
        return {
            tool: 'cursor',
            owningSource,
            generatedTargets: [],
            plannedWrites: [],
            verification: { valid: true, errors: [] },
            removal: { strategy: 'none', targets: [] },
        };
    }
    const target = join(projectRoot, '.cursor', 'rules', 'engineering-governance.mdc');
    const content = renderCursorRule(options.identity);
    return {
        tool: 'cursor',
        owningSource,
        generatedTargets: [target],
        plannedWrites: planGeneratedFile(target, content),
        verification: generatedVerification(target, content),
        removal: { strategy: 'generated-file', targets: [target] },
    };
}
