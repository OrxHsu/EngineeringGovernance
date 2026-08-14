import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { planCodexInstall, verifyCodexInstall } from '../adapters/codex.js';
import { planLauncherInstall, verifyLauncherInstall } from '../adapters/launcher.js';
import { planSkillInstall, verifySkillInstall } from '../adapters/skill.js';
import { applyPlannedWrites } from '../project/mutate.js';
import { governanceIdentity } from './adopt.js';
function sha256(input) {
    return createHash('sha256').update(input).digest('hex');
}
function planDigest(plan) {
    return sha256(JSON.stringify({
        tool: plan.tool,
        homeDirectory: plan.homeDirectory,
        governanceVersion: plan.governanceVersion,
        governanceDigest: plan.governanceDigest,
        writes: plan.writes.map((write) => ({
            path: write.path,
            beforeDigest: write.beforeDigest,
            afterDigest: sha256(write.after),
            mode: write.mode,
        })),
    }));
}
export function planGlobalInstall(options) {
    if (options.tool !== 'codex')
        throw new Error(`GLOBAL_TOOL_UNSUPPORTED:${options.tool}`);
    const homeDirectory = resolve(options.homeDirectory ?? homedir());
    const identity = governanceIdentity();
    const codex = planCodexInstall({ homeDirectory, identity });
    const skill = planSkillInstall({
        targetDirectory: join(homeDirectory, '.codex', 'skills', 'delivery-sop'),
    });
    const launcher = planLauncherInstall({ homeDirectory });
    const unsigned = {
        tool: 'codex',
        homeDirectory,
        governanceVersion: identity.version,
        governanceDigest: identity.digest,
        writes: [...codex.writes, ...skill.writes, ...launcher],
    };
    return { ...unsigned, digest: planDigest(unsigned) };
}
export function summarizeGlobalPlan(plan) {
    return {
        tool: plan.tool,
        homeDirectory: plan.homeDirectory,
        governanceVersion: plan.governanceVersion,
        governanceDigest: plan.governanceDigest,
        digest: plan.digest,
        writes: plan.writes.map((write) => ({
            path: write.path,
            beforeDigest: write.beforeDigest,
            afterDigest: sha256(write.after),
            ...(write.mode === undefined ? {} : { mode: write.mode }),
        })),
    };
}
export function applyGlobalInstall(plan, reviewedDigest) {
    if (plan.digest !== reviewedDigest)
        throw new Error('GLOBAL_PLAN_DIGEST_MISMATCH');
    return applyPlannedWrites(plan.writes, { dryRun: false });
}
export function checkGlobalInstall(options) {
    if (options.tool !== 'codex') {
        return { valid: false, errors: [`GLOBAL_TOOL_UNSUPPORTED:${options.tool}`] };
    }
    const homeDirectory = resolve(options.homeDirectory ?? homedir());
    const identity = governanceIdentity();
    const codex = verifyCodexInstall({ homeDirectory, identity });
    const skill = verifySkillInstall({
        targetDirectory: join(homeDirectory, '.codex', 'skills', 'delivery-sop'),
    });
    const launcher = verifyLauncherInstall({ homeDirectory });
    const errors = [...new Set([...codex.errors, ...skill.errors, ...launcher.errors])].sort();
    return { valid: errors.length === 0, errors };
}
