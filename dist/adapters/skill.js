import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyPlannedWrites } from '../project/mutate.js';
const managedMarker = '.engineering-governance-skill.json';
const managedFiles = ['SKILL.md', 'agents/openai.yaml'];
function sha256(input) {
    return createHash('sha256').update(input).digest('hex');
}
function defaultSourceDirectory() {
    return fileURLToPath(new URL('../../skills/delivery-sop', import.meta.url));
}
function sourceMarker(sourceDirectory) {
    const files = Object.fromEntries(managedFiles.map((relativePath) => [
        relativePath,
        sha256(readFileSync(join(sourceDirectory, relativePath), 'utf8')),
    ]));
    return {
        schemaVersion: 1,
        skill: 'delivery-sop',
        sourceDigest: sha256(JSON.stringify(files)),
        files,
    };
}
function readInstalledMarker(targetDirectory) {
    const markerPath = join(targetDirectory, managedMarker);
    if (!existsSync(markerPath))
        throw new Error('SKILL_TARGET_UNMANAGED');
    try {
        const marker = JSON.parse(readFileSync(markerPath, 'utf8'));
        if (marker.schemaVersion !== 1
            || marker.skill !== 'delivery-sop'
            || typeof marker.sourceDigest !== 'string'
            || typeof marker.files !== 'object'
            || marker.files === null) {
            throw new Error('invalid marker');
        }
        return marker;
    }
    catch {
        throw new Error('SKILL_TARGET_UNMANAGED');
    }
}
function verifyManagedFiles(targetDirectory, marker) {
    for (const [relativePath, expectedDigest] of Object.entries(marker.files).sort()) {
        const path = join(targetDirectory, relativePath);
        if (!existsSync(path) || sha256(readFileSync(path, 'utf8')) !== expectedDigest) {
            throw new Error(`SKILL_MANAGED_FILE_DRIFTED:${relativePath}`);
        }
    }
}
function plannedWrite(path, after) {
    const before = existsSync(path) ? readFileSync(path, 'utf8') : undefined;
    if (before === after)
        return undefined;
    return {
        path,
        beforeDigest: before === undefined ? null : sha256(before),
        after,
    };
}
function planDigest(plan) {
    return sha256(JSON.stringify({
        sourceDirectory: plan.sourceDirectory,
        targetDirectory: plan.targetDirectory,
        sourceDigest: plan.sourceDigest,
        writes: plan.writes.map((write) => ({
            path: write.path,
            beforeDigest: write.beforeDigest,
            afterDigest: sha256(write.after),
        })),
    }));
}
export function planSkillInstall(options) {
    const sourceDirectory = resolve(options.sourceDirectory ?? defaultSourceDirectory());
    const targetDirectory = resolve(options.targetDirectory);
    if (existsSync(targetDirectory)) {
        if (lstatSync(targetDirectory).isSymbolicLink() || !lstatSync(targetDirectory).isDirectory()) {
            throw new Error('SKILL_TARGET_UNMANAGED');
        }
        const installed = readInstalledMarker(targetDirectory);
        verifyManagedFiles(targetDirectory, installed);
    }
    const marker = sourceMarker(sourceDirectory);
    const writes = managedFiles
        .map((relativePath) => plannedWrite(join(targetDirectory, relativePath), readFileSync(join(sourceDirectory, relativePath), 'utf8')))
        .filter((write) => write !== undefined);
    const markerText = `${JSON.stringify(marker, null, 2)}\n`;
    const markerWrite = plannedWrite(join(targetDirectory, managedMarker), markerText);
    if (markerWrite)
        writes.push(markerWrite);
    const unsigned = {
        sourceDirectory,
        targetDirectory,
        sourceDigest: marker.sourceDigest,
        writes,
    };
    return { ...unsigned, digest: planDigest(unsigned) };
}
export function applySkillPlan(plan, reviewedDigest) {
    if (plan.digest !== reviewedDigest)
        throw new Error('SKILL_PLAN_DIGEST_MISMATCH');
    applyPlannedWrites(plan.writes, { dryRun: false });
}
export function verifySkillInstall(options) {
    const targetDirectory = resolve(options.targetDirectory);
    try {
        const installed = readInstalledMarker(targetDirectory);
        verifyManagedFiles(targetDirectory, installed);
        const source = sourceMarker(resolve(options.sourceDirectory ?? defaultSourceDirectory()));
        const errors = installed.sourceDigest === source.sourceDigest
            ? []
            : ['SKILL_SOURCE_DIGEST_MISMATCH'];
        return { valid: errors.length === 0, errors };
    }
    catch (error) {
        return {
            valid: false,
            errors: [error instanceof Error ? error.message : 'SKILL_VERIFICATION_FAILED'],
        };
    }
}
