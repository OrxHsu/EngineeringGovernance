import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { extname, relative, resolve } from 'node:path';
import { parse } from 'yaml';
import { canonicalDigest } from '../model/digest.js';
import { normalizeActorId } from '../model/actor.js';
import { implementationOwnersOf } from '../model/ownership.js';
import { captureRepositorySet } from '../evidence/checkout-snapshot.js';
import { actorEligibilityErrors, isRemediationBridgeContract } from './enforce.js';
import { assertAccountabilityPolicy } from './policy.js';
import { validateDocument } from '../policy/load.js';
import { mutualReviewEnabled, mutualReviewErrors, selfReviewSubjectDigest } from '../review/mutual-review.js';
import { runEnhancedPreflightRules } from './preflight-rules.js';
import { enforcePermanentGates } from './permanent-gates.js';
export const PREFLIGHT_CHECK_IDS = [
    'input_schema',
    'authority_resolvability',
    'design_binding_schema',
    'design_binding_references',
    'acceptance_coverage',
    'risk_classification',
    'actor_eligibility',
    'actor_permanent_gates',
    'authorization',
    'repository_baselines',
    'open_choices',
];
function sha256(value) {
    return createHash('sha256').update(value).digest('hex');
}
function readSemantic(path, raw) {
    if (['.yaml', '.yml', '.json'].includes(extname(path))) {
        try {
            return canonicalDigest(parse(raw.toString('utf8')));
        }
        catch { /* fall through */ }
    }
    return canonicalDigest(raw.toString('utf8'));
}
function policyIdentity(projectRoot) {
    const path = resolve(projectRoot, '.delivery', 'policy.yaml');
    const policy = parse(readFileSync(path, 'utf8'));
    if (typeof policy.sopVersion !== 'string' || typeof policy.sopDigest !== 'string')
        throw new Error('PREFLIGHT_POLICY_INVALID');
    return { version: policy.sopVersion, digest: policy.sopDigest };
}
function safeInputPath(inputPath) {
    const path = realpathSync(resolve(inputPath));
    if (lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile())
        throw new Error('PREFLIGHT_INPUT_UNSAFE');
    return path;
}
function exactKeys(value, required, optional = []) {
    const allowed = new Set([...required, ...optional]);
    const keys = Object.keys(value);
    return required.every((key) => Object.hasOwn(value, key)) && keys.every((key) => allowed.has(key));
}
function record(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function validDesignBindings(value) {
    return designBindingErrors(value).length === 0;
}
function uniqueIds(collection) {
    return Array.isArray(collection) && collection.every(record) && collection.every((item) => typeof item.id === 'string' && item.id.length > 0)
        && new Set(collection.map((item) => item.id)).size === collection.length
        && collection.every((item, index) => index === 0 || String(collection[index - 1]?.id).localeCompare(String(item.id)) < 0);
}
const bindingSpecs = {
    deliverables: {
        keys: ['id', 'repositoryId', 'path', 'kind', 'schemaRef', 'artifactType'],
        enums: { kind: ['source', 'schema', 'document', 'template', 'test', 'script', 'generated'] },
    },
    authorities: { keys: ['id', 'location', 'repositoryId', 'path', 'rawSha256', 'semanticDigest'], enums: { location: ['repository', 'external'] } },
    constants: { keys: ['id', 'valueType', 'value', 'sourceRef'], enums: { valueType: ['string', 'integer', 'boolean', 'digest', 'path', 'state'] } },
    equalities: { keys: ['id', 'leftRef', 'rightRef', 'comparison'], enums: { comparison: ['exact_string', 'canonical_semantic_digest', 'raw_sha256', 'ordered_set', 'normalized_actor'] } },
    transitions: { keys: ['id', 'from', 'to', 'actorRoleRef', 'artifactKindRefs', 'authorizationRefs'], enums: {} },
    actorRoles: { keys: ['id', 'actorId', 'requiredStanding', 'distinctFrom'], enums: { requiredStanding: ['GOOD_STANDING', 'WARNING', 'WATCH', 'PROBATION', 'SUSPENDED'] } },
    artifactKinds: { keys: ['id', 'pathPattern', 'schemaRef', 'minimumCount', 'maximumCount'], enums: {} },
};
function designBindingErrors(value) {
    const errors = [];
    const collections = Object.keys(bindingSpecs);
    if (!record(value) || !exactKeys(value, collections))
        return ['PREFLIGHT_DESIGN_BINDINGS_SCHEMA_INVALID'];
    const bindings = value;
    const ids = new Set();
    for (const collection of collections) {
        const spec = bindingSpecs[collection];
        const items = bindings[collection];
        if (!Array.isArray(items) || !uniqueIds(items)) {
            errors.push(`PREFLIGHT_DESIGN_BINDING_COLLECTION_INVALID:${collection}`);
            continue;
        }
        for (const item of items) {
            const object = item;
            if (!exactKeys(object, [...spec.keys]))
                errors.push(`PREFLIGHT_DESIGN_BINDING_KEYS_INVALID:${collection}:${String(object.id)}`);
            for (const [key, allowed] of Object.entries(spec.enums)) {
                if (!allowed.includes(String(object[key])))
                    errors.push(`PREFLIGHT_DESIGN_BINDING_ENUM_INVALID:${collection}:${String(object.id)}:${key}`);
            }
            const id = String(object.id);
            if (ids.has(id))
                errors.push(`PREFLIGHT_DESIGN_BINDING_ID_DUPLICATE:${id}`);
            ids.add(id);
            if (collection === 'artifactKinds') {
                if (!Number.isInteger(object.minimumCount) || Number(object.minimumCount) < 0)
                    errors.push(`PREFLIGHT_ARTIFACT_KIND_MINIMUM_INVALID:${id}`);
                if (object.maximumCount !== 'none' && (!Number.isInteger(object.maximumCount) || Number(object.maximumCount) < 0))
                    errors.push(`PREFLIGHT_ARTIFACT_KIND_MAXIMUM_INVALID:${id}`);
            }
            if (collection === 'actorRoles' && !Array.isArray(object.distinctFrom))
                errors.push(`PREFLIGHT_ACTOR_ROLE_DISTINCT_INVALID:${id}`);
            if (collection === 'transitions' && (!Array.isArray(object.artifactKindRefs) || !Array.isArray(object.authorizationRefs)))
                errors.push(`PREFLIGHT_TRANSITION_REFS_INVALID:${id}`);
        }
    }
    return errors;
}
function deriveRisk(signals) {
    if (signals.projectMinimum === 'R3' || signals.security === true || signals.authorization === true || signals.migration === true)
        return 'R3';
    if (signals.projectMinimum === 'R2' || signals.crossModule === true || signals.classificationComplete === true)
        return 'R2';
    if (signals.mutation === true || signals.localEdit === true)
        return 'R1';
    return 'R0';
}
function riskForSignals(value) {
    return deriveRisk(record(value) ? value : {});
}
function normalizeActorIdSafe(value) {
    try {
        return normalizeActorId(String(value));
    }
    catch {
        return '';
    }
}
function authorityErrors(projectRoot, input) {
    const errors = [];
    const bindings = record(input.designBindings) && Array.isArray(input.designBindings.authorities) ? input.designBindings.authorities : [];
    const byPath = new Map(bindings.filter(record).map((item) => [String(item.path), item]));
    const repositories = new Map(input.repositories.map((repository) => [repository.id, repository]));
    for (const candidate of input.authorityInputs) {
        const absolute = resolve(projectRoot, candidate);
        const relativePath = relative(projectRoot, absolute);
        if (relativePath.startsWith('..') || (candidate.startsWith('/') && absolute !== candidate)) {
            const external = byPath.get(candidate);
            if (!external || typeof external.rawSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(external.rawSha256))
                errors.push(`PREFLIGHT_EXTERNAL_AUTHORITY_UNHASHED:${candidate}`);
            if (!existsSync(absolute) || lstatSync(absolute).isSymbolicLink() || !lstatSync(absolute).isFile() || realpathSync(absolute) !== absolute)
                errors.push(`PREFLIGHT_AUTHORITY_UNSAFE:${candidate}`);
            else if (external && typeof external.rawSha256 === 'string' && sha256(readFileSync(absolute)) !== external.rawSha256)
                errors.push(`PREFLIGHT_AUTHORITY_DIGEST_MISMATCH:${candidate}`);
            continue;
        }
        if (!existsSync(absolute) || lstatSync(absolute).isSymbolicLink() || !lstatSync(absolute).isFile() || realpathSync(absolute) !== absolute) {
            errors.push(`PREFLIGHT_AUTHORITY_UNSAFE:${candidate}`);
        }
    }
    for (const authority of bindings.filter(record)) {
        const location = authority.location;
        const path = typeof authority.path === 'string' ? authority.path : '';
        if (location === 'repository') {
            const repository = repositories.get(String(authority.repositoryId));
            if (repository === undefined || path.startsWith('/') || path.split('/').includes('..'))
                errors.push(`PREFLIGHT_AUTHORITY_BINDING_INVALID:${String(authority.id)}`);
        }
        else if (location === 'external') {
            if (!path.startsWith('/') || typeof authority.rawSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(authority.rawSha256))
                errors.push(`PREFLIGHT_EXTERNAL_AUTHORITY_UNHASHED:${String(authority.id)}`);
        }
    }
    return errors;
}
function bindingReferenceErrors(input) {
    const errors = [];
    if (!record(input.designBindings))
        return ['PREFLIGHT_DESIGN_BINDING_REFERENCES_INVALID'];
    const bindings = input.designBindings;
    const collections = Object.keys(bindingSpecs);
    const ids = new Set();
    for (const collection of collections) {
        for (const item of Array.isArray(bindings[collection]) ? bindings[collection] : []) {
            if (record(item) && typeof item.id === 'string')
                ids.add(item.id);
        }
    }
    const authorizationIds = Array.isArray(input.authorizationRequirements)
        ? input.authorizationRequirements.filter(record).map((item) => String(item.id))
        : [];
    const known = (value) => typeof value === 'string' && (value === 'none' || ids.has(value) || authorizationIds.includes(value) || [...ids].some((id) => value.startsWith(`${id}.`)));
    const authorities = Array.isArray(bindings.authorities) ? bindings.authorities : [];
    for (const item of authorities)
        if (record(item) && item.location === 'repository' && !input.repositories.some((repository) => repository.id === item.repositoryId))
            errors.push(`PREFLIGHT_DANGLING_REPOSITORY:${String(item.id)}`);
    const equalities = Array.isArray(bindings.equalities) ? bindings.equalities : [];
    for (const item of equalities)
        if (record(item) && (!known(item.leftRef) || !known(item.rightRef)))
            errors.push(`PREFLIGHT_DANGLING_EQUALITY:${String(item.id)}`);
    const transitions = Array.isArray(bindings.transitions) ? bindings.transitions : [];
    for (const item of transitions)
        if (record(item)) {
            if (!known(item.actorRoleRef))
                errors.push(`PREFLIGHT_DANGLING_ACTOR_ROLE:${String(item.id)}`);
            for (const ref of Array.isArray(item.artifactKindRefs) ? item.artifactKindRefs : [])
                if (!known(ref))
                    errors.push(`PREFLIGHT_DANGLING_ARTIFACT_KIND:${String(item.id)}`);
            for (const ref of Array.isArray(item.authorizationRefs) ? item.authorizationRefs : [])
                if (!known(ref))
                    errors.push(`PREFLIGHT_DANGLING_AUTHORIZATION:${String(item.id)}`);
        }
    return errors;
}
export function preflightTaskInput(projectRootInput, inputPathInput) {
    const projectRoot = realpathSync(resolve(projectRootInput));
    let inputPath;
    let raw;
    let input;
    try {
        inputPath = safeInputPath(inputPathInput);
        raw = readFileSync(inputPath);
        input = parse(raw.toString('utf8'));
    }
    catch (error) {
        return { valid: false, errors: [error instanceof Error ? error.message : 'PREFLIGHT_INPUT_INVALID'], inputRawSha256: '', inputSemanticDigest: '' };
    }
    const inputRawSha256 = sha256(raw);
    const inputSemanticDigest = canonicalDigest(input);
    const errors = [];
    if (!record(input))
        errors.push('PREFLIGHT_INPUT_SCHEMA_INVALID');
    const value = (record(input) ? input : {});
    const required = ['schemaVersion', 'taskId', 'contractAuthor', 'objective', 'scope', 'nonGoals', 'authorityInputs', 'repositories', 'acceptance', 'authorizationRequirements', 'evidenceFreshnessMs', 'designBindings', 'predecessors', 'openChoices', 'signals'];
    if (!record(input) || !exactKeys(value, required, ['implementationOwner', 'implementationOwners', 'artifactType', 'contractPreflight', 'extensions', 'selfReview', 'knownIssues']))
        errors.push('PREFLIGHT_INPUT_SCHEMA_INVALID');
    let implementationOwners = [];
    try {
        implementationOwners = implementationOwnersOf(value);
    }
    catch {
        errors.push('PREFLIGHT_IMPLEMENTATION_OWNERS_INVALID');
    }
    if (value.schemaVersion !== 2 || typeof value.taskId !== 'string' || typeof value.contractAuthor !== 'string' || implementationOwners.length === 0)
        errors.push('PREFLIGHT_INPUT_FIELDS_INVALID');
    if (value.openChoices === undefined || !Array.isArray(value.openChoices) || value.openChoices.length !== 0)
        errors.push('PREFLIGHT_OPEN_CHOICES_NOT_EMPTY');
    errors.push(...designBindingErrors(value.designBindings));
    const remediationException = isRemediationBridgeContract(value)
        && normalizeActorIdSafe(value.contractAuthor) === 'codex'
        && implementationOwners.length === 1
        && implementationOwners[0] === 'codex';
    if (validDesignBindings(value.designBindings)) {
        for (const key of ['deliverables', 'authorities', 'constants', 'equalities', 'transitions', 'actorRoles', 'artifactKinds']) {
            if (!uniqueIds(value.designBindings[key]))
                errors.push(`PREFLIGHT_DESIGN_BINDING_IDS_INVALID:${key}`);
        }
        errors.push(...bindingReferenceErrors(value));
        const designBindings = value.designBindings;
        const actorRoles = Array.isArray(designBindings.actorRoles)
            ? designBindings.actorRoles.filter(record)
            : [];
        if ((riskForSignals(value.signals) === 'R2' || riskForSignals(value.signals) === 'R3') && actorRoles.length < implementationOwners.length + 3 && !remediationException)
            errors.push('PREFLIGHT_ACTOR_ROLE_COVERAGE_INVALID');
        const actorIds = actorRoles.map((item) => normalizeActorIdSafe(item.actorId));
        if (new Set(actorIds).size !== actorIds.length)
            errors.push('PREFLIGHT_ACTOR_ROLE_IDENTITY_DUPLICATE');
        for (const owner of implementationOwners)
            if (!actorIds.includes(owner))
                errors.push(`PREFLIGHT_IMPLEMENTATION_OWNER_ROLE_MISSING:${owner}`);
        if ((riskForSignals(value.signals) === 'R2' || riskForSignals(value.signals) === 'R3') && actorRoles.some((item) => item.requiredStanding !== 'GOOD_STANDING') && !remediationException)
            errors.push('PREFLIGHT_ACTOR_ROLE_STANDING_INVALID');
    }
    let policy;
    try {
        policy = policyIdentity(projectRoot);
        assertAccountabilityPolicy(projectRoot);
    }
    catch {
        return { valid: false, errors: [...new Set([...errors, 'PREFLIGHT_POLICY_INVALID'])].sort(), inputRawSha256, inputSemanticDigest };
    }
    if (record(input) && Array.isArray(value.authorityInputs) && Array.isArray(value.repositories)) {
        try {
            errors.push(...authorityErrors(projectRoot, value));
        }
        catch {
            errors.push('PREFLIGHT_AUTHORITY_INVALID');
        }
    }
    let contractAuthor = '';
    try {
        contractAuthor = normalizeActorId(String(value.contractAuthor));
    }
    catch {
        errors.push('PREFLIGHT_ACTOR_INVALID');
    }
    const risk = deriveRisk(record(value.signals) ? value.signals : {});
    const enhancedRules = mutualReviewEnabled(value)
        ? runEnhancedPreflightRules(value, risk)
        : [];
    if (mutualReviewEnabled(value)) {
        errors.push(...mutualReviewErrors(value));
        for (const rule of enhancedRules)
            errors.push(...rule.errors);
    }
    if ((risk === 'R2' || risk === 'R3') && implementationOwners.includes(contractAuthor) && !remediationException)
        errors.push('PREFLIGHT_AUTHOR_OWNER_SELF_REVIEW');
    if (contractAuthor)
        errors.push(...enforcePermanentGates(projectRoot, contractAuthor, value, risk).errors);
    for (const implementationOwner of implementationOwners.filter((owner) => owner !== contractAuthor)) {
        errors.push(...enforcePermanentGates(projectRoot, implementationOwner, value, risk).errors);
    }
    if (contractAuthor)
        errors.push(...actorEligibilityErrors({ projectRoot, taskId: String(value.taskId), actorId: contractAuthor, role: 'contract-author', risk }).map((error) => `PREFLIGHT_CONTRACT_AUTHOR_${error}`));
    for (const implementationOwner of implementationOwners) {
        errors.push(...actorEligibilityErrors({ projectRoot, taskId: String(value.taskId), actorId: implementationOwner, role: 'implementation-owner', risk }).map((error) => `PREFLIGHT_IMPLEMENTATION_OWNER_${implementationOwner}_${error}`));
    }
    const acceptance = Array.isArray(value.acceptance) ? value.acceptance : [];
    const allBindingRefs = new Set(acceptance.flatMap((item) => Array.isArray(item?.bindingRefs) ? item.bindingRefs : []));
    if (acceptance.length === 0 || acceptance.some((item) => !record(item) || !Array.isArray(item.bindingRefs) || item.bindingRefs.length === 0 || !Array.isArray(item.positiveCases) || !item.positiveCases.length || !Array.isArray(item.negativeCases) || !item.negativeCases.length))
        errors.push('PREFLIGHT_ACCEPTANCE_COVERAGE_INVALID');
    const authorizationRequirements = Array.isArray(value.authorizationRequirements) ? value.authorizationRequirements : [];
    const authorizationIds = authorizationRequirements.filter(record).map((item) => String(item.id));
    if (new Set(authorizationIds).size !== authorizationIds.length)
        errors.push('PREFLIGHT_AUTHORIZATION_IDS_DUPLICATED');
    const authorizationRequired = risk === 'R3' && record(value.signals) && ['authorization', 'production', 'deployment', 'remoteMutation', 'restrictedRuntime', 'destructive', 'payments', 'externalCommunication'].some((key) => value.signals[key] === true);
    if (authorizationRequired && authorizationRequirements.length === 0)
        errors.push('PREFLIGHT_AUTHORIZATION_REQUIRED');
    if (authorizationRequirements.some((item) => !record(item) || typeof item.id !== 'string' || typeof item.action !== 'string' || typeof item.target !== 'string' || !Array.isArray(item.scope) || item.scope.length === 0 || item.consumeOnce !== true))
        errors.push('PREFLIGHT_AUTHORIZATION_SCHEMA_INVALID');
    if (validDesignBindings(value.designBindings)) {
        const bindingIds = Object.values(value.designBindings).flatMap((collection) => Array.isArray(collection) ? collection.map((item) => record(item) ? String(item.id) : '') : []);
        for (const id of bindingIds)
            if (!allBindingRefs.has(id))
                errors.push(`PREFLIGHT_BINDING_UNUSED:${id}`);
    }
    let baselines = [];
    try {
        const repositories = Array.isArray(value.repositories) ? value.repositories : [];
        const snapshots = captureRepositorySet(repositories.filter(record).map((item) => ({ id: String(item.id), path: String(item.path) })));
        baselines = snapshots.map((snapshot) => ({ id: snapshot.id, path: snapshot.repository, head: snapshot.head, tree: snapshot.tree, checkoutDigest: snapshot.statusDigest }));
    }
    catch {
        errors.push('PREFLIGHT_REPOSITORY_BASELINE_INVALID');
    }
    const checkEvidence = [inputPath];
    const checks = [
        ...PREFLIGHT_CHECK_IDS.map((id) => ({ id, status: 'PASS', evidenceRefs: checkEvidence })),
        ...(mutualReviewEnabled(value)
            ? enhancedRules.map((rule) => ({ id: rule.id, status: 'PASS', evidenceRefs: checkEvidence }))
            : []),
        ...(mutualReviewEnabled(value) ? [{ id: 'self_review', status: 'PASS', evidenceRefs: checkEvidence }] : []),
    ];
    const warnings = enhancedRules.flatMap((rule) => rule.warnings);
    if (errors.length > 0)
        return { valid: false, errors: [...new Set(errors)].sort(), inputRawSha256, inputSemanticDigest, ...(warnings.length > 0 ? { warnings } : {}) };
    const unsigned = {
        schemaVersion: 1,
        artifactType: 'engineering-governance-contract-preflight-v1',
        taskId: String(value.taskId),
        projectRoot,
        policyVersion: policy.version,
        policyDigest: policy.digest,
        inputRawSha256,
        inputSemanticDigest,
        contractSemanticDigest: canonicalDigest(input),
        repositoryBaselines: baselines,
        checks,
        ...(warnings.length > 0 ? { warnings } : {}),
        ...(mutualReviewEnabled(value) ? { selfReviewSubjectDigest: selfReviewSubjectDigest(value) } : {}),
    };
    const plan = { ...unsigned, planDigest: canonicalDigest(unsigned) };
    return { valid: true, errors: [], plan, inputRawSha256, inputSemanticDigest, ...(warnings.length > 0 ? { warnings } : {}) };
}
export function verifyPreflightPlan(plan, projectRootInput, inputPath) {
    const schema = validateDocument('contract-preflight', plan);
    if (!schema.valid)
        return { valid: false, errors: schema.errors.map((error) => `PREFLIGHT_PLAN_SCHEMA_INVALID:${error}`), inputRawSha256: '', inputSemanticDigest: '' };
    const current = preflightTaskInput(projectRootInput, inputPath);
    if (!current.valid || current.plan === undefined)
        return current;
    const { planDigest, ...unsigned } = plan;
    if (canonicalDigest(unsigned) !== planDigest)
        return { ...current, valid: false, errors: ['PREFLIGHT_PLAN_INVALID'] };
    if (plan.planDigest !== current.plan.planDigest || plan.inputRawSha256 !== current.inputRawSha256)
        return { ...current, valid: false, errors: ['PREFLIGHT_PLAN_STALE'] };
    return current;
}
