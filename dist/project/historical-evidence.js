import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { parse } from 'yaml';
import { canonicalDigest } from '../model/digest.js';
import { validateDocument } from '../policy/load.js';
export const HISTORICAL_EVIDENCE_PATH_KEY = 'taskGraph.historicalEvidenceManifestPath';
export const HISTORICAL_EVIDENCE_SHA_KEY = 'taskGraph.historicalEvidenceManifestSha256';
function sha256(input) {
    return createHash('sha256').update(input).digest('hex');
}
function evidenceDigest(raw, originalPath) {
    if (['.yaml', '.yml', '.json'].includes(extname(originalPath))) {
        try {
            return canonicalDigest(parse(raw.toString('utf8')));
        }
        catch { /* plain bytes below */ }
    }
    return canonicalDigest(raw.toString('utf8'));
}
function record(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function safeFile(root, relativePath, prefix) {
    if (!relativePath.startsWith(prefix) || relativePath.split('/').includes('..'))
        return undefined;
    const path = resolve(root, relativePath);
    if (!path.startsWith(`${root}/${prefix}`))
        return undefined;
    try {
        if (!existsSync(path) || lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile())
            return undefined;
        return realpathSync(path) === path ? path : undefined;
    }
    catch {
        return undefined;
    }
}
export function historicalEvidenceKey(input) {
    return `${input.path}\0${input.sha256}\0${input.digest}`;
}
export function loadHistoricalEvidence(projectRootInput) {
    const entries = new Map();
    const root = realpathSync(resolve(projectRootInput));
    const policyPath = resolve(root, '.delivery/policy.yaml');
    if (!existsSync(policyPath))
        return { valid: true, errors: [], entries };
    let policy;
    try {
        policy = parse(readFileSync(policyPath, 'utf8'));
    }
    catch {
        return { valid: false, errors: ['HISTORICAL_EVIDENCE_POLICY_UNREADABLE'], entries };
    }
    if (!record(policy) || !record(policy.artifactMapping)) {
        return { valid: false, errors: ['HISTORICAL_EVIDENCE_MAPPING_INVALID'], entries };
    }
    const configuredPath = policy.artifactMapping[HISTORICAL_EVIDENCE_PATH_KEY];
    const configuredSha = policy.artifactMapping[HISTORICAL_EVIDENCE_SHA_KEY];
    if (configuredPath === undefined && configuredSha === undefined)
        return { valid: true, errors: [], entries };
    if (typeof configuredPath !== 'string' || typeof configuredSha !== 'string' || !/^[a-f0-9]{64}$/u.test(configuredSha)) {
        return { valid: false, errors: ['HISTORICAL_EVIDENCE_MAPPING_INVALID'], entries };
    }
    const manifestPath = safeFile(root, configuredPath, '.delivery/compatibility/');
    if (manifestPath === undefined)
        return { valid: false, errors: ['HISTORICAL_EVIDENCE_MANIFEST_PATH_INVALID'], entries };
    const raw = readFileSync(manifestPath);
    const errors = [];
    if (sha256(raw) !== configuredSha)
        errors.push('HISTORICAL_EVIDENCE_MANIFEST_SHA_MISMATCH');
    let document;
    try {
        document = parse(raw.toString('utf8'));
    }
    catch {
        document = undefined;
    }
    const schema = validateDocument('historical-evidence-compatibility', document);
    if (!schema.valid)
        errors.push(...schema.errors.map((error) => `HISTORICAL_EVIDENCE_MANIFEST_INVALID:${error}`));
    if (schema.valid && record(document)) {
        const manifest = document;
        const { manifestDigest, ...unsigned } = manifest;
        if (canonicalDigest(unsigned) !== manifestDigest)
            errors.push('HISTORICAL_EVIDENCE_MANIFEST_DIGEST_MISMATCH');
        if (manifest.projectId !== policy.projectId)
            errors.push('HISTORICAL_EVIDENCE_PROJECT_MISMATCH');
        let previous = '';
        for (const entry of manifest.entries) {
            const key = historicalEvidenceKey(entry);
            if (key <= previous || entries.has(key))
                errors.push('HISTORICAL_EVIDENCE_ENTRIES_NOT_SORTED_UNIQUE');
            previous = key;
            entries.set(key, entry);
            const snapshot = safeFile(root, entry.snapshotPath, '.delivery/compatibility/evidence/');
            const snapshotRaw = snapshot === undefined ? undefined : readFileSync(snapshot);
            if (snapshot === undefined
                || entry.snapshotSha256 !== entry.sha256
                || snapshotRaw === undefined
                || sha256(snapshotRaw) !== entry.snapshotSha256
                || evidenceDigest(snapshotRaw, entry.path) !== entry.digest) {
                errors.push(`HISTORICAL_EVIDENCE_SNAPSHOT_INVALID:${entry.path}`);
            }
        }
    }
    return { valid: errors.length === 0, errors: [...new Set(errors)].sort(), entries };
}
