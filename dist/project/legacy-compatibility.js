import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { parse } from 'yaml';
import { canonicalDigest } from '../model/digest.js';
import { validateDocument } from '../policy/load.js';
import { readRunnerArchiveFile } from './runner-bundle.js';
import { canTransition } from '../state/transitions.js';
export const LEGACY_MANIFEST_PATH_KEY = 'taskGraph.legacySchemaV2ManifestPath';
export const LEGACY_MANIFEST_SHA_KEY = 'taskGraph.legacySchemaV2ManifestSha256';
function sha256(input) {
    return createHash('sha256').update(input).digest('hex');
}
function record(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function safeRegularFile(path) {
    try {
        if (!existsSync(path) || lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile())
            return undefined;
        return realpathSync(path);
    }
    catch {
        return undefined;
    }
}
function safeProjectPath(projectRoot, relativePath) {
    if (relativePath.startsWith('/') || relativePath.split('/').includes('..'))
        return undefined;
    const unresolved = resolve(projectRoot, relativePath);
    const canonicalRoot = realpathSync(projectRoot);
    if (unresolved !== canonicalRoot && !unresolved.startsWith(`${canonicalRoot}/`))
        return undefined;
    const canonical = safeRegularFile(unresolved);
    return canonical === unresolved ? canonical : undefined;
}
function inventory(taskRoot, errors) {
    const files = [];
    const visit = (directory) => {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
            const path = join(directory, entry.name);
            if (entry.isSymbolicLink()) {
                errors.push(`TASK_GRAPH_LEGACY_FILE_UNSAFE:${relative(taskRoot, path)}`);
            }
            else if (entry.isDirectory()) {
                visit(path);
            }
            else if (entry.isFile()) {
                files.push({ path: relative(taskRoot, path), sha256: sha256(readFileSync(path)) });
            }
            else {
                errors.push(`TASK_GRAPH_LEGACY_FILE_UNSAFE:${relative(taskRoot, path)}`);
            }
        }
    };
    visit(taskRoot);
    return files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
}
function sortedUniqueFiles(files) {
    return files.every((file, index) => (index === 0 || files[index - 1].path < file.path)) && new Set(files.map((file) => file.path)).size === files.length;
}
function manifestPath(projectRoot, value) {
    if (typeof value !== 'string' || !value.startsWith('.delivery/compatibility/'))
        return undefined;
    if (value.split('/').includes('..'))
        return undefined;
    const unresolved = resolve(projectRoot, value);
    const canonicalRoot = realpathSync(projectRoot);
    if (!unresolved.startsWith(`${canonicalRoot}/.delivery/compatibility/`))
        return undefined;
    const canonical = safeRegularFile(unresolved);
    return canonical === unresolved ? canonical : undefined;
}
function runnerArchivePath(projectRoot, value) {
    if (typeof value !== 'string' || !value.startsWith('.delivery/runtime/'))
        return undefined;
    if (value.split('/').includes('..'))
        return undefined;
    const unresolved = resolve(projectRoot, value);
    const canonicalRoot = realpathSync(projectRoot);
    if (!unresolved.startsWith(`${canonicalRoot}/.delivery/runtime/`))
        return undefined;
    const canonical = safeRegularFile(unresolved);
    return canonical === unresolved ? canonical : undefined;
}
export function loadLegacyCompatibilityManifest(projectRootInput, policy) {
    const entries = new Map();
    const mapping = policy?.artifactMapping;
    if (mapping === undefined) {
        return { valid: true, errors: [], entries };
    }
    if (typeof mapping !== 'object' || mapping === null || Array.isArray(mapping)) {
        return { valid: false, errors: ['TASK_GRAPH_LEGACY_MAPPING_INVALID'], entries };
    }
    const values = mapping;
    const configuredPath = values[LEGACY_MANIFEST_PATH_KEY];
    const configuredSha = values[LEGACY_MANIFEST_SHA_KEY];
    if (configuredPath === undefined && configuredSha === undefined) {
        return { valid: true, errors: [], entries };
    }
    const projectRoot = realpathSync(resolve(projectRootInput));
    const errors = [];
    const path = manifestPath(projectRoot, configuredPath);
    if (path === undefined) {
        return { valid: false, errors: ['TASK_GRAPH_LEGACY_MANIFEST_PATH_INVALID'], entries };
    }
    if (typeof configuredSha !== 'string' || !/^[a-f0-9]{64}$/u.test(configuredSha)) {
        return { valid: false, errors: ['TASK_GRAPH_LEGACY_MANIFEST_SHA_INVALID'], entries };
    }
    const raw = readFileSync(path);
    if (sha256(raw) !== configuredSha)
        errors.push('TASK_GRAPH_LEGACY_MANIFEST_SHA_MISMATCH');
    let document;
    try {
        document = parse(raw.toString('utf8'));
    }
    catch {
        document = undefined;
    }
    const schema = validateDocument('legacy-task-compatibility', document);
    if (!schema.valid)
        errors.push(...schema.errors.map((error) => `TASK_GRAPH_LEGACY_MANIFEST_INVALID:${error}`));
    if (schema.valid && document !== null && typeof document === 'object' && !Array.isArray(document)) {
        const manifest = document;
        const { manifestDigest, ...unsigned } = manifest;
        if (canonicalDigest(unsigned) !== manifestDigest) {
            errors.push('TASK_GRAPH_LEGACY_MANIFEST_DIGEST_MISMATCH');
        }
        if (manifest.entries.length === 0 || !manifest.entries.every((entry, index) => (index === 0 || manifest.entries[index - 1].taskId < entry.taskId)))
            errors.push('TASK_GRAPH_LEGACY_MANIFEST_ENTRIES_NOT_SORTED_UNIQUE');
        for (const entry of manifest.entries) {
            if (entries.has(entry.taskId))
                errors.push(`TASK_GRAPH_LEGACY_MANIFEST_DUPLICATE_TASK:${entry.taskId}`);
            entries.set(entry.taskId, entry);
            if (!sortedUniqueFiles(entry.files)) {
                errors.push(`TASK_GRAPH_LEGACY_MANIFEST_FILES_NOT_SORTED_UNIQUE:${entry.taskId}`);
            }
            if (entry.successor !== undefined && !entry.successor.findingIds.every((findingId, index) => (index === 0 || entry.successor.findingIds[index - 1] < findingId)))
                errors.push(`TASK_GRAPH_LEGACY_MANIFEST_FINDINGS_NOT_SORTED_UNIQUE:${entry.taskId}`);
        }
        if (manifest.projectId !== policy?.projectId)
            errors.push('TASK_GRAPH_LEGACY_MANIFEST_PROJECT_MISMATCH');
    }
    return {
        valid: errors.length === 0,
        errors: [...new Set(errors)].sort(),
        manifestPath: path,
        entries,
    };
}
function runnerErrors(projectRoot, entry) {
    const errors = [];
    if (entry.source.runner.version !== entry.source.sopVersion)
        errors.push('RUNNER_SOURCE_VERSION_MISMATCH');
    const path = runnerArchivePath(projectRoot, entry.source.runner.path);
    if (path === undefined)
        return ['RUNNER_ARCHIVE_INVALID'];
    if (sha256(readFileSync(path)) !== entry.source.runner.sha256)
        errors.push('RUNNER_ARCHIVE_DIGEST_MISMATCH');
    try {
        const packageJson = JSON.parse(readRunnerArchiveFile(path, 'package.json').toString('utf8'));
        const version = readRunnerArchiveFile(path, 'VERSION').toString('utf8').trim();
        if (packageJson.name !== '@xgh/engineering-governance'
            || packageJson.version !== entry.source.runner.version
            || version !== entry.source.runner.version) {
            errors.push('RUNNER_ARCHIVE_VERSION_MISMATCH');
        }
    }
    catch {
        errors.push('RUNNER_ARCHIVE_UNREADABLE');
    }
    return errors;
}
function ledgerErrors(projectRoot, taskId, contractRaw, contractDigest, entry) {
    const errors = [];
    const taskRoot = join(projectRoot, '.delivery', 'tasks', taskId);
    const ledgerPath = join(taskRoot, 'ledger.jsonl');
    const ledgerCanonical = safeRegularFile(ledgerPath);
    if (ledgerCanonical === undefined)
        return ['LEDGER_MISSING_OR_UNSAFE'];
    const raw = readFileSync(ledgerCanonical);
    if (sha256(raw) !== entry.ledger.rawSha256)
        errors.push('LEDGER_DIGEST_MISMATCH');
    const lines = raw.toString('utf8').split('\n').filter((line) => line.length > 0);
    if (lines.length === 0)
        return ['LEDGER_EMPTY'];
    const events = [];
    for (const [index, line] of lines.entries()) {
        let parsed;
        try {
            parsed = JSON.parse(line);
        }
        catch {
            errors.push(`LEDGER_EVENT_JSON_INVALID:${index + 1}`);
            continue;
        }
        if (!record(parsed)) {
            errors.push(`LEDGER_EVENT_SCHEMA_INVALID:${index + 1}:NOT_OBJECT`);
            continue;
        }
        const event = parsed;
        const schema = validateDocument('task-event', event);
        if (!schema.valid) {
            errors.push(...schema.errors.map((error) => `LEDGER_EVENT_SCHEMA_INVALID:${index + 1}:${error}`));
            continue;
        }
        const { eventDigest, ...unsigned } = event;
        if (canonicalDigest(unsigned) !== eventDigest)
            errors.push(`LEDGER_EVENT_DIGEST_INVALID:${index + 1}`);
        if (event.sequence !== index + 1)
            errors.push(`LEDGER_EVENT_SEQUENCE_INVALID:${index + 1}`);
        if (event.contractDigest !== contractDigest)
            errors.push(`LEDGER_EVENT_CONTRACT_MISMATCH:${index + 1}`);
        const previous = events.at(-1);
        if (index === 0) {
            if (event.previousEventDigest !== null || event.from !== null || event.to !== 'DEFINED') {
                errors.push('LEDGER_INITIAL_TRANSITION_INVALID');
            }
            const contractRef = event.artifactRefs.length === 1 ? event.artifactRefs[0] : undefined;
            if (contractRef?.kind !== 'contract'
                || contractRef.path !== `.delivery/tasks/${taskId}/contract.yaml`
                || contractRef.sha256 !== sha256(contractRaw))
                errors.push('LEDGER_INITIAL_CONTRACT_REF_MISMATCH');
        }
        else if (previous !== undefined) {
            if (event.previousEventDigest !== previous.eventDigest)
                errors.push(`LEDGER_PREVIOUS_DIGEST_MISMATCH:${index + 1}`);
            if (event.from !== previous.to || !canTransition(previous.to, event.to)) {
                errors.push(`LEDGER_TRANSITION_INVALID:${index + 1}`);
            }
        }
        for (const ref of event.artifactRefs) {
            const path = safeProjectPath(projectRoot, ref.path);
            if (path === undefined || sha256(readFileSync(path)) !== ref.sha256) {
                errors.push(`LEDGER_ARTIFACT_REF_INVALID:${index + 1}:${ref.path}`);
            }
        }
        events.push(event);
    }
    const final = events.at(-1);
    if (final === undefined || final.to !== entry.ledger.finalState || final.eventDigest !== entry.ledger.finalEventDigest) {
        errors.push('LEDGER_FINAL_IDENTITY_MISMATCH');
    }
    return errors;
}
function predecessorGraphErrors(projectRoot, taskId, compatibilityTaskIds, stack, visited) {
    if (compatibilityTaskIds.has(taskId))
        return ['SUCCESSOR_PREDECESSOR_COMPATIBILITY_CYCLE'];
    if (stack.has(taskId))
        return ['SUCCESSOR_PREDECESSOR_GRAPH_CYCLE'];
    if (visited.has(taskId))
        return [];
    const path = join(projectRoot, '.delivery', 'tasks', taskId, 'contract.yaml');
    const canonical = safeRegularFile(path);
    if (canonical === undefined)
        return ['SUCCESSOR_PREDECESSOR_CONTRACT_MISSING_OR_UNSAFE'];
    let contract;
    try {
        contract = parse(readFileSync(canonical, 'utf8'));
    }
    catch {
        return ['SUCCESSOR_PREDECESSOR_CONTRACT_UNREADABLE'];
    }
    if (!record(contract) || contract.taskId !== taskId || contract.schemaVersion !== 2) {
        return ['SUCCESSOR_PREDECESSOR_CONTRACT_INVALID'];
    }
    const nextStack = new Set(stack).add(taskId);
    const errors = [];
    if (Array.isArray(contract.predecessors)) {
        for (const predecessor of contract.predecessors) {
            if (!record(predecessor) || typeof predecessor.taskId !== 'string') {
                errors.push('SUCCESSOR_PREDECESSOR_GRAPH_INVALID');
                continue;
            }
            errors.push(...predecessorGraphErrors(projectRoot, predecessor.taskId, compatibilityTaskIds, nextStack, visited));
        }
    }
    visited.add(taskId);
    return errors;
}
function successorErrors(projectRoot, entry, compatibilityTaskIds) {
    if (entry.classification !== 'superseded-readiness-history')
        return [];
    if (entry.successor === undefined
        || entry.successor.taskId === entry.taskId
        || compatibilityTaskIds.has(entry.successor.taskId))
        return ['SUCCESSOR_BINDING_INVALID'];
    const path = join(projectRoot, '.delivery', 'tasks', entry.successor.taskId, 'contract.yaml');
    const canonical = safeRegularFile(path);
    if (canonical === undefined)
        return ['SUCCESSOR_CONTRACT_MISSING_OR_UNSAFE'];
    const raw = readFileSync(canonical);
    if (sha256(raw) !== entry.successor.contractRawSha256)
        return ['SUCCESSOR_CONTRACT_DIGEST_MISMATCH'];
    let parsedContract;
    try {
        parsedContract = parse(raw.toString('utf8'));
    }
    catch {
        return ['SUCCESSOR_CONTRACT_UNREADABLE'];
    }
    if (!record(parsedContract))
        return ['SUCCESSOR_CONTRACT_INVALID'];
    const contract = parsedContract;
    const { contractDigest, ...unsigned } = contract;
    if (contract.schemaVersion !== 2
        || contract.taskId !== entry.successor.taskId
        || contract.sopVersion !== '2.1.0'
        || canonicalDigest(unsigned) !== contractDigest
        || contractDigest !== entry.successor.contractDigest) {
        return ['SUCCESSOR_CONTRACT_SEMANTIC_DIGEST_MISMATCH'];
    }
    const schema = validateDocument('task-contract', contract);
    if (!schema.valid)
        return ['SUCCESSOR_CONTRACT_SCHEMA_INVALID'];
    const predecessors = contract.predecessors;
    if (!Array.isArray(predecessors))
        return ['SUCCESSOR_PREDECESSOR_BINDING_MISSING'];
    const matchingPredecessors = predecessors.filter((item) => (typeof item === 'object' && item !== null && !Array.isArray(item)
        && item.taskId === entry.taskId));
    const predecessor = matchingPredecessors[0];
    if (matchingPredecessors.length !== 1 || predecessor === undefined
        || predecessor.contractPath !== `.delivery/tasks/${entry.taskId}/contract.yaml`
        || predecessor.contractRawSha256 !== entry.contract.rawSha256
        || predecessor.contractDigest !== entry.contract.digest
        || predecessor.reviewPath !== `.delivery/tasks/${entry.taskId}/contract-review.yaml`
        || predecessor.reviewRawSha256 !== entry.successor.reviewRawSha256
        || predecessor.decision !== entry.successor.decision
        || JSON.stringify(predecessor.findingIds) !== JSON.stringify([...entry.successor.findingIds].sort())) {
        return ['SUCCESSOR_PREDECESSOR_BINDING_MISMATCH'];
    }
    const reviewPath = join(projectRoot, '.delivery', 'tasks', entry.taskId, 'contract-review.yaml');
    const reviewCanonical = safeRegularFile(reviewPath);
    if (reviewCanonical === undefined || sha256(readFileSync(reviewCanonical)) !== entry.successor.reviewRawSha256) {
        return ['SUCCESSOR_PREDECESSOR_REVIEW_IDENTITY_MISMATCH'];
    }
    let parsedReview;
    try {
        parsedReview = parse(readFileSync(reviewCanonical, 'utf8'));
    }
    catch {
        return ['SUCCESSOR_PREDECESSOR_REVIEW_UNREADABLE'];
    }
    if (!record(parsedReview))
        return ['SUCCESSOR_PREDECESSOR_REVIEW_INVALID'];
    const review = parsedReview;
    const findings = Array.isArray(review.findings)
        ? review.findings.flatMap((finding) => (typeof finding === 'object' && finding !== null && !Array.isArray(finding)
            && typeof finding.id === 'string'
            ? [finding.id]
            : [])).sort()
        : [];
    if (review.decision !== entry.successor.decision
        || JSON.stringify(findings) !== JSON.stringify(entry.successor.findingIds)) {
        return ['SUCCESSOR_PREDECESSOR_REVIEW_CONTENT_MISMATCH'];
    }
    const errors = [];
    for (const other of predecessors) {
        if (!record(other) || typeof other.taskId !== 'string' || other.taskId === entry.taskId)
            continue;
        errors.push(...predecessorGraphErrors(projectRoot, other.taskId, compatibilityTaskIds, new Set([entry.successor.taskId]), new Set()));
    }
    return [...new Set(errors)].sort();
}
export function verifyLegacyTaskCompatibility(input) {
    if (input.entry === undefined)
        return { valid: false, errors: ['TASK_GRAPH_LEGACY_ENTRY_MISSING'] };
    const entry = input.entry;
    const errors = [];
    if (entry.taskId !== input.taskId)
        errors.push('TASK_ID_MISMATCH');
    if (input.contract.schemaVersion !== 2 || input.contract.taskId !== input.taskId)
        errors.push('CONTRACT_SCHEMA_OR_TASK_MISMATCH');
    if (input.contract.sopVersion !== entry.source.sopVersion || input.contract.policyDigest !== entry.source.policyDigest) {
        errors.push('CONTRACT_SOURCE_IDENTITY_MISMATCH');
    }
    if (sha256(input.contractRaw) !== entry.contract.rawSha256)
        errors.push('CONTRACT_RAW_DIGEST_MISMATCH');
    const { contractDigest, ...unsignedContract } = input.contract;
    if (typeof contractDigest !== 'string' || canonicalDigest(unsignedContract) !== contractDigest || contractDigest !== entry.contract.digest) {
        errors.push('CONTRACT_SEMANTIC_DIGEST_MISMATCH');
    }
    if (entry.classification === 'beta0-beta3-history' && !/^2\.1\.0-beta\.[0-3]$/u.test(entry.source.sopVersion)) {
        errors.push('CLASSIFICATION_VERSION_MISMATCH');
    }
    if (entry.classification === 'superseded-readiness-history' && entry.source.sopVersion !== '2.1.0') {
        errors.push('CLASSIFICATION_VERSION_MISMATCH');
    }
    try {
        errors.push(...runnerErrors(input.projectRoot, entry));
        const actualFiles = inventory(input.taskRoot, errors);
        if (JSON.stringify(actualFiles) !== JSON.stringify(entry.files))
            errors.push('TASK_FILE_INVENTORY_MISMATCH');
        errors.push(...ledgerErrors(input.projectRoot, input.taskId, input.contractRaw, String(contractDigest), entry));
        errors.push(...successorErrors(input.projectRoot, entry, input.compatibilityTaskIds));
    }
    catch {
        errors.push('LEGACY_COMPATIBILITY_UNREADABLE');
    }
    return { valid: errors.length === 0, errors: [...new Set(errors)].sort(), entry };
}
export function legacyManifestTaskIds(manifest) {
    return [...manifest.entries.keys()].sort();
}
