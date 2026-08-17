import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { externalSourceMinimumRisk, validateExternalSourceTaskInput } from '../extensions/external-source.js';
import { extensionDescriptor } from '../extensions/registry.js';
import { canonicalDigest } from '../model/digest.js';
import { implementationOwnersOf } from '../model/ownership.js';
import { CURRENT_CONTRACT_READINESS_VERSION, CURRENT_SOP_VERSION } from '../model/version.js';
import { classifyRisk, highestRisk } from './risk.js';
import { validateDocument } from './load.js';
const authorizationSignals = [
    'migration',
    'destructive',
    'payments',
    'production',
    'deployment',
    'remoteMutation',
    'externalCommunication',
    'restrictedRuntime',
];
function sha256(input) {
    return createHash('sha256').update(input).digest('hex');
}
function duplicated(values) {
    return new Set(values).size !== values.length;
}
function semanticErrors(contract) {
    const errors = [];
    let implementationOwners = [];
    try {
        implementationOwners = implementationOwnersOf(contract);
        if (contract.implementationOwners !== undefined
            && JSON.stringify(contract.implementationOwners) !== JSON.stringify(implementationOwners)) {
            errors.push('TASK_IMPLEMENTATION_OWNERS_NOT_CANONICAL');
        }
    }
    catch (error) {
        errors.push(error instanceof Error ? error.message : 'TASK_IMPLEMENTATION_OWNERS_INVALID');
    }
    const repositoryIds = contract.repositories.map((repository) => repository.id);
    const repositoryPaths = contract.repositories.map((repository) => repository.path);
    if (duplicated(repositoryIds))
        errors.push('TASK_REPOSITORY_IDS_DUPLICATED');
    if (duplicated(repositoryPaths))
        errors.push('TASK_REPOSITORY_PATHS_DUPLICATED');
    let expectedRisk = classifyRisk(contract.riskSignals);
    const extensionKeys = contract.extensions.map((extension) => `${extension.id}@${extension.version}`);
    if (duplicated(extensionKeys))
        errors.push('TASK_EXTENSIONS_DUPLICATED');
    if (JSON.stringify(extensionKeys) !== JSON.stringify([...extensionKeys].sort())) {
        errors.push('TASK_EXTENSIONS_NOT_CANONICAL');
    }
    for (const extension of contract.extensions) {
        try {
            const descriptor = extensionDescriptor(extension.id, extension.version);
            if (descriptor.digest !== extension.digest) {
                errors.push(`TASK_EXTENSION_DIGEST_MISMATCH:${extension.id}@${extension.version}`);
            }
            if (extension.id === 'external-source-provenance') {
                const input = validateExternalSourceTaskInput(extension.input);
                const minimum = externalSourceMinimumRisk(input);
                if (minimum !== undefined)
                    expectedRisk = highestRisk([expectedRisk, minimum]);
            }
        }
        catch (error) {
            errors.push(error instanceof Error ? error.message : `TASK_EXTENSION_INVALID:${extension.id}`);
        }
    }
    if (contract.risk !== expectedRisk) {
        errors.push(`TASK_CONTRACT_RISK_MISMATCH:${contract.risk}:${expectedRisk}`);
    }
    if (contract.contractReadiness !== undefined) {
        const expectedRequired = contract.risk === 'R2' || contract.risk === 'R3';
        const expectedPath = `.delivery/tasks/${contract.taskId}/contract-review.yaml`;
        if (contract.contractReadiness.required !== expectedRequired) {
            errors.push('TASK_CONTRACT_READINESS_REQUIREMENT_MISMATCH');
        }
        if (contract.contractReadiness.reviewPath !== expectedPath) {
            errors.push('TASK_CONTRACT_READINESS_PATH_MISMATCH');
        }
        const expectedGateVersion = contract.sopVersion === CURRENT_SOP_VERSION
            ? CURRENT_CONTRACT_READINESS_VERSION
            : contract.selfReview !== undefined
                ? '2.1.0-beta.2'
                : contract.contractAuthor === undefined ? '2.1.0-beta.0' : '2.1.0-beta.1';
        if (contract.contractReadiness.gateVersion !== expectedGateVersion) {
            errors.push('TASK_CONTRACT_READINESS_VERSION_MISMATCH');
        }
    }
    const beta1Contract = contract.contractAuthor !== undefined
        || contract.contractPreflight !== undefined
        || contract.designBindings !== undefined
        || contract.predecessors !== undefined
        || contract.selfReview !== undefined
        || contract.knownIssues !== undefined;
    if (beta1Contract) {
        if (typeof contract.contractAuthor !== 'string' || contract.contractAuthor.length === 0)
            errors.push('TASK_CONTRACT_AUTHOR_REQUIRED');
        if (contract.contractPreflight === undefined || typeof contract.contractPreflight !== 'object' || contract.contractPreflight === null) {
            errors.push('TASK_CONTRACT_PREFLIGHT_REQUIRED');
        }
        else {
            const schema = validateDocument('contract-preflight', contract.contractPreflight);
            if (!schema.valid)
                errors.push(...schema.errors.map((error) => `TASK_CONTRACT_PREFLIGHT_INVALID:${error}`));
            const preflight = contract.contractPreflight;
            const { planDigest, ...unsignedPreflight } = preflight;
            if (typeof planDigest !== 'string' || canonicalDigest(unsignedPreflight) !== planDigest)
                errors.push('TASK_CONTRACT_PREFLIGHT_DIGEST_MISMATCH');
            if (preflight.taskId !== contract.taskId || preflight.policyDigest !== contract.policyDigest)
                errors.push('TASK_CONTRACT_PREFLIGHT_BINDING_MISMATCH');
        }
        if (contract.designBindings === undefined || typeof contract.designBindings !== 'object' || contract.designBindings === null)
            errors.push('TASK_CONTRACT_DESIGN_BINDINGS_REQUIRED');
        if (!Array.isArray(contract.predecessors))
            errors.push('TASK_CONTRACT_PREDECESSORS_REQUIRED');
        if ((contract.selfReview === undefined) !== (contract.knownIssues === undefined)) {
            errors.push('TASK_CONTRACT_MUTUAL_REVIEW_INCOMPLETE');
        }
        if (contract.selfReview !== undefined) {
            const subjectDigest = contract.contractPreflight?.selfReviewSubjectDigest;
            if (typeof contract.selfReview.subjectDigest !== 'string'
                || subjectDigest !== contract.selfReview.subjectDigest) {
                errors.push('TASK_CONTRACT_SELF_REVIEW_BINDING_MISMATCH');
            }
        }
        if ((contract.risk === 'R2' || contract.risk === 'R3')
            && implementationOwners.includes(contract.contractAuthor ?? '')) {
            errors.push('TASK_CONTRACT_AUTHOR_OWNER_NOT_DISTINCT');
        }
        if (contract.openChoices !== undefined && (!Array.isArray(contract.openChoices) || contract.openChoices.length !== 0))
            errors.push('TASK_CONTRACT_OPEN_CHOICES_NOT_EMPTY');
    }
    const acceptanceIds = contract.acceptance.map((gate) => gate.id);
    if (duplicated(acceptanceIds))
        errors.push('TASK_ACCEPTANCE_IDS_DUPLICATED');
    const repositorySet = new Set(repositoryIds);
    for (const gate of contract.acceptance) {
        const repository = contract.repositories.find((candidate) => candidate.id === gate.command.repositoryId);
        if (!repositorySet.has(gate.command.repositoryId) || repository === undefined) {
            errors.push(`TASK_GATE_REPOSITORY_UNKNOWN:${gate.id}`);
            continue;
        }
        if (isAbsolute(gate.command.cwd))
            errors.push(`TASK_GATE_CWD_MUST_BE_RELATIVE:${gate.id}`);
        const cwd = resolve(repository.path, gate.command.cwd);
        const relativePath = relative(repository.path, cwd);
        if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
            errors.push(`TASK_GATE_CWD_OUTSIDE_REPOSITORY:${gate.id}`);
        }
        try {
            if (!isAbsolute(gate.command.executable)
                || !existsSync(gate.command.executable)
                || lstatSync(gate.command.executable).isSymbolicLink()
                || !lstatSync(gate.command.executable).isFile()
                || realpathSync(gate.command.executable) !== gate.command.executable) {
                errors.push(`TASK_GATE_EXECUTABLE_UNSAFE:${gate.id}`);
            }
            else if (sha256(readFileSync(gate.command.executable)) !== gate.command.executableSha256) {
                errors.push(`TASK_GATE_EXECUTABLE_DIGEST_MISMATCH:${gate.id}`);
            }
        }
        catch {
            errors.push(`TASK_GATE_EXECUTABLE_UNSAFE:${gate.id}`);
        }
        if (gate.observerPolicy.output === 'exact') {
            if (gate.observerPolicy.expectedStdoutSha256 === undefined
                || gate.observerPolicy.expectedStderrSha256 === undefined) {
                errors.push(`TASK_GATE_EXACT_OUTPUT_DIGEST_REQUIRED:${gate.id}`);
            }
        }
        else if (gate.observerPolicy.expectedStdoutSha256 !== undefined
            || gate.observerPolicy.expectedStderrSha256 !== undefined) {
            errors.push(`TASK_GATE_EXACT_OUTPUT_DIGEST_UNEXPECTED:${gate.id}`);
        }
    }
    const authorizationIds = contract.authorizationRequirements.map((requirement) => requirement.id);
    if (duplicated(authorizationIds))
        errors.push('AUTHORIZATION_REQUIREMENT_IDS_DUPLICATED');
    if (authorizationSignals.some((signal) => contract.riskSignals[signal] === true)
        && authorizationIds.length === 0) {
        errors.push('TASK_AUTHORIZATION_REQUIREMENT_MISSING');
    }
    const { contractDigest, ...unsigned } = contract;
    if (canonicalDigest(unsigned) !== contractDigest)
        errors.push('TASK_CONTRACT_DIGEST_MISMATCH');
    return errors;
}
export function validateHardenedTaskContract(input) {
    const schema = validateDocument('task-contract', input);
    if (!schema.valid)
        return { valid: false, errors: schema.errors.map((error) => `TASK_CONTRACT_SCHEMA_INVALID:${error}`) };
    if (typeof input !== 'object' || input === null || input.schemaVersion !== 2) {
        return { valid: false, errors: ['TASK_CONTRACT_VERSION_UNSUPPORTED'] };
    }
    const errors = [...new Set(semanticErrors(input))].sort();
    return { valid: errors.length === 0, errors };
}
