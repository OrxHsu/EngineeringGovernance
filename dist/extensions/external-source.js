import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { validateDocument } from '../policy/load.js';
export const externalSourceExtensionId = 'external-source-provenance';
export const externalSourceExtensionVersion = '1.0.0';
function record(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function exactKeys(value, expected) {
    return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}
function exactPath(value) {
    return typeof value === 'string'
        && value.length > 0
        && !value.startsWith('/')
        && !value.split('/').includes('..')
        && !/[*?\[\]{}!]/u.test(value);
}
function stringArray(value, allowEmpty) {
    return Array.isArray(value)
        && (allowEmpty || value.length > 0)
        && value.every((item) => typeof item === 'string' && item.length > 0)
        && new Set(value).size === value.length;
}
function orderedBy(values, key) {
    const keys = values.map(key);
    return JSON.stringify(keys) === JSON.stringify([...keys].sort());
}
export function validateExternalSourceTaskInput(value) {
    if (!record(value))
        throw new Error('EXTERNAL_SOURCE_INPUT_INVALID');
    if (value.mode === 'independent') {
        if (!exactKeys(value, ['mode']))
            throw new Error('EXTERNAL_SOURCE_INDEPENDENT_INPUT_NOT_EMPTY');
        return { mode: 'independent' };
    }
    if (value.mode !== 'source-assisted' || !exactKeys(value, [
        'mode',
        'allocationId',
        'accessMode',
        'source',
        'sourceUnits',
        'destinations',
        'independentDestinations',
        'releaseDecisionRequired',
    ]))
        throw new Error('EXTERNAL_SOURCE_INPUT_INVALID');
    if (typeof value.allocationId !== 'string' || value.allocationId.length === 0) {
        throw new Error('EXTERNAL_SOURCE_ALLOCATION_ID_REQUIRED');
    }
    if (!['inspect', 'adapt', 'copy-exact'].includes(String(value.accessMode))) {
        throw new Error('EXTERNAL_SOURCE_ACCESS_MODE_INVALID');
    }
    if (!record(value.source) || !exactKeys(value.source, ['locator', 'pin'])) {
        throw new Error('EXTERNAL_SOURCE_LOCATOR_INVALID');
    }
    const { locator, pin } = value.source;
    if (!record(locator) || !exactKeys(locator, ['kind', 'uri'])
        || !['git', 'archive', 'filesystem'].includes(String(locator.kind))
        || typeof locator.uri !== 'string' || locator.uri.length === 0) {
        throw new Error('EXTERNAL_SOURCE_LOCATOR_INVALID');
    }
    if (!record(pin) || !exactKeys(pin, ['algorithm', 'digest'])
        || !['git-commit', 'sha256'].includes(String(pin.algorithm))
        || typeof pin.digest !== 'string'
        || (pin.algorithm === 'git-commit' ? !/^[a-f0-9]{40,64}$/u.test(pin.digest) : !/^[a-f0-9]{64}$/u.test(pin.digest))) {
        throw new Error('EXTERNAL_SOURCE_PIN_INVALID');
    }
    if (!Array.isArray(value.sourceUnits) || value.sourceUnits.length === 0) {
        throw new Error('EXTERNAL_SOURCE_UNITS_REQUIRED');
    }
    const sourceIds = new Set();
    for (const unit of value.sourceUnits) {
        if (!record(unit) || !exactKeys(unit, ['id', 'path', 'symbols'])
            || typeof unit.id !== 'string' || unit.id.length === 0 || sourceIds.has(unit.id)
            || !exactPath(unit.path) || !stringArray(unit.symbols, false)) {
            throw new Error('EXTERNAL_SOURCE_UNIT_INVALID');
        }
        sourceIds.add(unit.id);
    }
    if (!orderedBy(value.sourceUnits, (unit) => unit.id)) {
        throw new Error('EXTERNAL_SOURCE_RECORD_ORDER_MISMATCH');
    }
    if (!Array.isArray(value.destinations) || value.destinations.length === 0) {
        throw new Error('EXTERNAL_SOURCE_DESTINATIONS_REQUIRED');
    }
    const destinationIds = new Set();
    for (const destination of value.destinations) {
        if (!record(destination) || !exactKeys(destination, ['repositoryId', 'path', 'symbols'])
            || typeof destination.repositoryId !== 'string' || destination.repositoryId.length === 0
            || !exactPath(destination.path) || !stringArray(destination.symbols, false)) {
            throw new Error('EXTERNAL_SOURCE_DESTINATION_INVALID');
        }
        const id = `${destination.repositoryId}\0${destination.path}`;
        if (destinationIds.has(id))
            throw new Error('EXTERNAL_SOURCE_DESTINATION_DUPLICATED');
        destinationIds.add(id);
    }
    if (!orderedBy(value.destinations, (destination) => `${destination.repositoryId}:${destination.path}`))
        throw new Error('EXTERNAL_SOURCE_RECORD_ORDER_MISMATCH');
    if (!Array.isArray(value.independentDestinations)) {
        throw new Error('EXTERNAL_SOURCE_INDEPENDENT_DESTINATIONS_INVALID');
    }
    for (const destination of value.independentDestinations) {
        if (!record(destination) || !exactKeys(destination, ['repositoryId', 'path', 'symbols'])
            || typeof destination.repositoryId !== 'string' || destination.repositoryId.length === 0
            || !exactPath(destination.path) || !stringArray(destination.symbols, false)) {
            throw new Error('EXTERNAL_SOURCE_INDEPENDENT_DESTINATION_INVALID');
        }
        const id = `${destination.repositoryId}\0${destination.path}`;
        if (destinationIds.has(id))
            throw new Error('EXTERNAL_SOURCE_DESTINATION_CLASSIFICATION_DUPLICATED');
        destinationIds.add(id);
    }
    if (!orderedBy(value.independentDestinations, (destination) => `${destination.repositoryId}:${destination.path}`))
        throw new Error('EXTERNAL_SOURCE_RECORD_ORDER_MISMATCH');
    if (value.releaseDecisionRequired !== true)
        throw new Error('EXTERNAL_SOURCE_RELEASE_DECISION_REQUIRED');
    return value;
}
export function externalSourceMinimumRisk(input) {
    return input.mode === 'source-assisted' ? 'R3' : undefined;
}
function sha256(input) {
    return createHash('sha256').update(input).digest('hex');
}
function readExtensionArtifact(input) {
    const unresolved = resolve(input.reference.path);
    if (lstatSync(unresolved).isSymbolicLink() || !lstatSync(unresolved).isFile()) {
        throw new Error(`EXTERNAL_SOURCE_ARTIFACT_UNSAFE:${input.kind}`);
    }
    const path = realpathSync(unresolved);
    const relativePath = relative(input.projectRoot, path);
    if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
        throw new Error(`EXTERNAL_SOURCE_ARTIFACT_OUTSIDE_PROJECT:${input.kind}`);
    }
    if (path !== join(input.taskDirectory, 'extensions', externalSourceExtensionId, `${input.kind}.json`))
        throw new Error(`EXTERNAL_SOURCE_ARTIFACT_CANONICAL_PATH_MISMATCH:${input.kind}`);
    const raw = readFileSync(path);
    if (sha256(raw) !== input.reference.sha256) {
        throw new Error(`EXTERNAL_SOURCE_ARTIFACT_DIGEST_MISMATCH:${input.kind}`);
    }
    return { path, raw };
}
function useAllowed(allocation, actual) {
    const rank = { inspect: 0, adapt: 1, 'copy-exact': 2 };
    return rank[actual] <= rank[allocation];
}
function canonicalDestination(input) {
    return {
        repositoryId: input.repositoryId,
        path: input.path,
        symbols: [...input.symbols].sort(),
    };
}
export function verifyExternalSourceArtifacts(input) {
    const errors = [];
    let taskInput;
    try {
        taskInput = validateExternalSourceTaskInput(input.binding.input);
    }
    catch (error) {
        return { errors: [error instanceof Error ? error.message : 'EXTERNAL_SOURCE_INPUT_INVALID'] };
    }
    if (taskInput.mode === 'independent') {
        if (input.references.length > 0)
            errors.push('EXTERNAL_SOURCE_INDEPENDENT_HAS_ARTIFACTS');
        return {
            errors,
            ...(errors.length === 0 ? {
                result: {
                    extensionId: externalSourceExtensionId,
                    version: externalSourceExtensionVersion,
                    status: 'satisfied',
                },
            } : {}),
        };
    }
    const expectedKinds = ['external-source-release', 'external-source-use'];
    const actualKinds = input.references.map((reference) => reference.kind).sort();
    if (JSON.stringify(actualKinds) !== JSON.stringify(expectedKinds)) {
        return { errors: ['EXTERNAL_SOURCE_ARTIFACT_SET_MISMATCH'] };
    }
    const useReference = input.references.find((reference) => reference.kind === 'external-source-use');
    const releaseReference = input.references.find((reference) => reference.kind === 'external-source-release');
    let use;
    let release;
    let usePath;
    let releasePath;
    try {
        const artifact = readExtensionArtifact({
            reference: useReference,
            projectRoot: input.projectRoot,
            taskDirectory: input.taskDirectory,
            kind: 'external-source-use',
        });
        usePath = artifact.path;
        use = JSON.parse(artifact.raw.toString('utf8'));
    }
    catch (error) {
        return { errors: [error instanceof Error ? error.message : 'EXTERNAL_SOURCE_USE_UNREADABLE'] };
    }
    try {
        const artifact = readExtensionArtifact({
            reference: releaseReference,
            projectRoot: input.projectRoot,
            taskDirectory: input.taskDirectory,
            kind: 'external-source-release',
        });
        releasePath = artifact.path;
        release = JSON.parse(artifact.raw.toString('utf8'));
    }
    catch (error) {
        return { errors: [error instanceof Error ? error.message : 'EXTERNAL_SOURCE_RELEASE_UNREADABLE'] };
    }
    const useSchema = validateDocument('external-source-use', use);
    const releaseSchema = validateDocument('external-source-release', release);
    if (!useSchema.valid)
        errors.push('EXTERNAL_SOURCE_USE_SCHEMA_INVALID');
    if (!releaseSchema.valid)
        errors.push('EXTERNAL_SOURCE_RELEASE_SCHEMA_INVALID');
    if (!useSchema.valid || !releaseSchema.valid)
        return { errors: [...new Set(errors)].sort() };
    for (const document of [use, release]) {
        if (document.taskId !== input.taskId)
            errors.push('EXTERNAL_SOURCE_TASK_MISMATCH');
        if (document.contractDigest !== input.contractDigest)
            errors.push('EXTERNAL_SOURCE_CONTRACT_MISMATCH');
        if (document.allocationId !== taskInput.allocationId)
            errors.push('EXTERNAL_SOURCE_ALLOCATION_MISMATCH');
        if (JSON.stringify(document.extension) !== JSON.stringify({
            id: input.binding.id,
            version: input.binding.version,
            digest: input.binding.digest,
        }))
            errors.push('EXTERNAL_SOURCE_EXTENSION_IDENTITY_MISMATCH');
    }
    const sourceIds = new Set(taskInput.sourceUnits.map((unit) => unit.id));
    if (new Set(use.sourceUses.map((entry) => entry.sourceUnitId)).size !== use.sourceUses.length) {
        errors.push('EXTERNAL_SOURCE_USE_IDS_DUPLICATED');
    }
    const sourceUseById = new Map(use.sourceUses.map((entry) => [entry.sourceUnitId, entry.use]));
    if (JSON.stringify([...sourceUseById.keys()].sort()) !== JSON.stringify([...sourceIds].sort())) {
        errors.push('EXTERNAL_SOURCE_USE_SET_MISMATCH');
    }
    if (!orderedBy(use.sourceUses, (entry) => entry.sourceUnitId)
        || !orderedBy(use.destinationUses, (entry) => `${entry.repositoryId}:${entry.path}`)
        || JSON.stringify(release.destinationIds) !== JSON.stringify([...release.destinationIds].sort()))
        errors.push('EXTERNAL_SOURCE_RECORD_ORDER_MISMATCH');
    for (const sourceUse of use.sourceUses) {
        if (!sourceIds.has(sourceUse.sourceUnitId) || !useAllowed(taskInput.accessMode, sourceUse.use)) {
            errors.push(`EXTERNAL_SOURCE_USE_UNALLOCATED:${sourceUse.sourceUnitId}`);
        }
    }
    const expectedDestinations = taskInput.destinations.map(canonicalDestination)
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    const actualDestinations = use.destinationUses.map(canonicalDestination)
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    if (JSON.stringify(actualDestinations) !== JSON.stringify(expectedDestinations)) {
        errors.push('EXTERNAL_SOURCE_DESTINATION_USE_MISMATCH');
    }
    for (const destination of use.destinationUses) {
        if (!destination.sourceUnitIds.every((id) => sourceIds.has(id))
            || !useAllowed(taskInput.accessMode, destination.use)) {
            errors.push(`EXTERNAL_SOURCE_DESTINATION_UNALLOCATED:${destination.repositoryId}:${destination.path}`);
        }
        for (const sourceUnitId of destination.sourceUnitIds) {
            const sourceUse = sourceUseById.get(sourceUnitId);
            if (sourceUse === undefined || !useAllowed(sourceUse, destination.use)) {
                errors.push(`EXTERNAL_SOURCE_USE_RELATION_MISMATCH:${destination.repositoryId}:${destination.path}:${sourceUnitId}`);
            }
        }
    }
    const expectedDestinationIds = taskInput.destinations
        .map((destination) => `${destination.repositoryId}:${destination.path}`).sort();
    if (JSON.stringify([...release.destinationIds].sort()) !== JSON.stringify(expectedDestinationIds)) {
        errors.push('EXTERNAL_SOURCE_RELEASE_SCOPE_MISMATCH');
    }
    if (release.decision !== 'approved')
        errors.push('EXTERNAL_SOURCE_RELEASE_BLOCKED');
    const classifiedPaths = [
        ...taskInput.destinations,
        ...taskInput.independentDestinations,
    ].map((destination) => ({
        repositoryId: destination.repositoryId,
        path: destination.path,
    })).sort((left, right) => (`${left.repositoryId}:${left.path}`.localeCompare(`${right.repositoryId}:${right.path}`)));
    const changedPaths = [...input.changedPaths].sort((left, right) => (`${left.repositoryId}:${left.path}`.localeCompare(`${right.repositoryId}:${right.path}`)));
    if (JSON.stringify(classifiedPaths) !== JSON.stringify(changedPaths)) {
        errors.push('EXTERNAL_SOURCE_CHANGED_PATH_CLASSIFICATION_MISMATCH');
    }
    for (const [kind, path, reference] of [
        ['external-source-use', usePath, useReference],
        ['external-source-release', releasePath, releaseReference],
    ]) {
        const expected = {
            kind: `extension:${externalSourceExtensionId}:${kind}`,
            path: relative(input.projectRoot, path),
            sha256: reference.sha256,
        };
        const occurrences = input.ledgerEvents.flatMap((event) => event.artifactRefs)
            .filter((artifact) => JSON.stringify(artifact) === JSON.stringify(expected)).length;
        if (occurrences !== 1)
            errors.push(`EXTERNAL_SOURCE_LEDGER_REF_INVALID:${kind}:${occurrences}`);
    }
    const uniqueErrors = [...new Set(errors)].sort();
    return {
        errors: uniqueErrors,
        ...(uniqueErrors.length === 0 ? {
            result: {
                extensionId: externalSourceExtensionId,
                version: externalSourceExtensionVersion,
                status: 'satisfied',
                releaseTrust: 'local-claim',
            },
        } : {}),
    };
}
