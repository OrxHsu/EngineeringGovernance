import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { applyPlannedWrites } from '../project/mutate.js';
import { planManagedBlockWrite } from '../project/managed-block.js';
import { MANAGED_BLOCK_END, MANAGED_BLOCK_START, renderCoreBlock, } from './render.js';
const managerOwnedSettingNames = new Set([
    'codex_agents_content',
    'common_agents_codex',
    'global_agents_codex',
]);
function sha256(input) {
    return createHash('sha256').update(input).digest('hex');
}
function planDigest(plan) {
    return sha256(JSON.stringify({
        action: plan.action,
        tool: plan.tool,
        target: plan.target,
        writes: plan.writes.map((write) => ({
            path: write.path,
            beforeDigest: write.beforeDigest,
            afterDigest: sha256(write.after),
            mode: write.mode,
        })),
    }));
}
export function inspectCcSwitchSettingNames(databasePath) {
    if (!existsSync(databasePath))
        return [];
    const result = spawnSync('sqlite3', [
        '-readonly',
        databasePath,
        'SELECT key FROM settings ORDER BY key;',
    ], { encoding: 'utf8' });
    if (result.status !== 0)
        throw new Error('CC_SWITCH_OWNERSHIP_INSPECTION_FAILED');
    return result.stdout.split(/\r?\n/u).filter(Boolean);
}
function assertNotManagerOwned(settingNames) {
    const owner = settingNames.find((name) => managerOwnedSettingNames.has(name));
    if (owner)
        throw new Error(`CODEX_AGENTS_MANAGER_OWNED:${owner}`);
}
function withoutNoOpWrites(writes) {
    return writes.filter((write) => {
        const before = existsSync(write.path) ? readFileSync(write.path, 'utf8') : undefined;
        return typeof write.after !== 'string' || before !== write.after;
    });
}
export function planCodexInstall(options) {
    const homeDirectory = resolve(options.homeDirectory);
    const databasePath = options.ccSwitchDatabasePath
        ?? join(homeDirectory, '.cc-switch', 'cc-switch.db');
    const settingNames = options.ccSwitchSettingNames
        ?? inspectCcSwitchSettingNames(databasePath);
    assertNotManagerOwned(settingNames);
    const target = join(homeDirectory, '.codex', 'AGENTS.md');
    const writes = withoutNoOpWrites([
        planManagedBlockWrite(target, renderCoreBlock(options.identity, '~/.codex/bin/sop').trimEnd()),
    ]);
    const unsigned = { action: 'install', tool: 'codex', target, writes };
    return { ...unsigned, digest: planDigest(unsigned) };
}
function removeManagedBlock(existing, expectedDigest) {
    const start = existing.indexOf(MANAGED_BLOCK_START);
    const end = existing.indexOf(MANAGED_BLOCK_END);
    if (start < 0 || end < start)
        throw new Error('CODEX_ADAPTER_MISSING');
    const endExclusive = end + MANAGED_BLOCK_END.length;
    const block = existing.slice(start, endExclusive);
    const digestMatch = block.match(/Governance digest: `([a-f0-9]{64})`/u);
    if (!digestMatch || digestMatch[1] !== expectedDigest) {
        throw new Error('CODEX_ADAPTER_DIGEST_MISMATCH');
    }
    let suffix = existing.slice(endExclusive);
    if (start === 0 && suffix.startsWith('\n\n'))
        suffix = suffix.slice(2);
    else if (start === 0 && suffix === '\n')
        suffix = '';
    return `${existing.slice(0, start)}${suffix}`;
}
export function planCodexRemoval(options) {
    const target = join(resolve(options.homeDirectory), '.codex', 'AGENTS.md');
    if (!existsSync(target))
        throw new Error('CODEX_ADAPTER_MISSING');
    const existing = readFileSync(target, 'utf8');
    const writes = [{
            path: target,
            beforeDigest: sha256(existing),
            after: removeManagedBlock(existing, options.expectedDigest),
        }];
    const unsigned = { action: 'remove', tool: 'codex', target, writes };
    return { ...unsigned, digest: planDigest(unsigned) };
}
export function applyCodexPlan(plan, reviewedDigest) {
    if (plan.digest !== reviewedDigest)
        throw new Error('CODEX_PLAN_DIGEST_MISMATCH');
    applyPlannedWrites(plan.writes, { dryRun: false });
}
export function verifyCodexInstall(options) {
    const target = join(resolve(options.homeDirectory), '.codex', 'AGENTS.md');
    if (!existsSync(target))
        return { valid: false, errors: ['CODEX_ADAPTER_MISSING'] };
    const existing = readFileSync(target, 'utf8');
    const expected = renderCoreBlock(options.identity, '~/.codex/bin/sop').trimEnd();
    const starts = existing.split(MANAGED_BLOCK_START).length - 1;
    const errors = starts === 1 && existing.includes(expected) ? [] : ['CODEX_ADAPTER_DRIFTED'];
    return { valid: errors.length === 0, errors };
}
