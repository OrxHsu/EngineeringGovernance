import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { MANAGED_BLOCK_END, MANAGED_BLOCK_START, renderCoreBlock, } from '../adapters/render.js';
export { MANAGED_BLOCK_END, MANAGED_BLOCK_START };
function digest(text) {
    return createHash('sha256').update(text).digest('hex');
}
export function createManagedBlock(identity) {
    return renderCoreBlock(identity).trimEnd();
}
function upsert(existing, block) {
    const start = existing.indexOf(MANAGED_BLOCK_START);
    const end = existing.indexOf(MANAGED_BLOCK_END);
    if ((start >= 0) !== (end >= 0) || (start >= 0 && end < start)) {
        throw new Error('MANAGED_BLOCK_MALFORMED');
    }
    if (start >= 0) {
        const suffixStart = end + MANAGED_BLOCK_END.length;
        return `${existing.slice(0, start)}${block}${existing.slice(suffixStart)}`;
    }
    if (existing.length === 0)
        return `${block}\n`;
    return `${block}\n\n${existing}`;
}
export function planManagedBlockWrite(path, block) {
    const exists = existsSync(path);
    const before = exists ? readFileSync(path, 'utf8') : '';
    return {
        path,
        beforeDigest: exists ? digest(before) : null,
        after: upsert(before, block),
    };
}
