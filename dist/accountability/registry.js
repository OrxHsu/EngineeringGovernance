import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { parse } from 'yaml';
import { normalizeActorId } from '../model/actor.js';
import { canonicalDigest } from '../model/digest.js';
import { implementationOwnersOf } from '../model/ownership.js';
import { validateDocument } from '../policy/load.js';
import { validateHardenedTaskContract } from '../policy/task-contract.js';
import { ACCOUNTABILITY_GENESIS_BYTES, ACCOUNTABILITY_GENESIS_DIGEST, ACCOUNTABILITY_REGISTRY_PATH, assertAccountabilityPolicy, permissionsForStanding, } from './policy.js';
export function assertAuthorizationContextTime(context, occurredAt) {
    const occurred = Date.parse(occurredAt);
    const issued = Date.parse(String(context.authorization.issuedAt));
    const expires = Date.parse(String(context.authorization.expiresAt));
    if (!Number.isFinite(occurred) || !Number.isFinite(issued) || !Number.isFinite(expires) || occurred < issued || occurred >= expires) {
        throw new Error('ACCOUNTABILITY_AUTHORIZATION_TIME_INVALID');
    }
}
function record(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function sha256(input) {
    return createHash('sha256').update(input).digest('hex');
}
function sameStringSet(left, right) {
    return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}
function registryPath(projectRoot) {
    const root = realpathSync(resolve(projectRoot));
    const path = join(root, ACCOUNTABILITY_REGISTRY_PATH);
    const parent = join(root, '.delivery', 'accountability');
    if (existsSync(parent) && (lstatSync(parent).isSymbolicLink() || !lstatSync(parent).isDirectory())) {
        throw new Error('ACCOUNTABILITY_REGISTRY_PARENT_UNSAFE');
    }
    return path;
}
function canonicalEventDigest(event) {
    return canonicalDigest(event);
}
function safeTaskId(value) {
    if (!/^[a-z0-9][a-z0-9._-]*$/u.test(value))
        throw new Error('ACCOUNTABILITY_AUTHORIZATION_TASK_INVALID');
}
function safeAuthorizationPath(projectRoot, candidate) {
    const root = realpathSync(resolve(projectRoot));
    const unresolved = isAbsolute(candidate) ? resolve(candidate) : resolve(root, candidate);
    const relativePath = relative(root, unresolved);
    if (relativePath.startsWith('..') || isAbsolute(relativePath) || relativePath === '') {
        throw new Error('ACCOUNTABILITY_AUTHORITY_PATH_INVALID');
    }
    if (!existsSync(unresolved) || lstatSync(unresolved).isSymbolicLink() || !lstatSync(unresolved).isFile() || realpathSync(unresolved) !== unresolved) {
        throw new Error('ACCOUNTABILITY_AUTHORITY_PATH_UNSAFE');
    }
    return unresolved;
}
function exactAuthorizationReference(value) {
    if (!record(value))
        return false;
    const keys = Object.keys(value).sort();
    if (JSON.stringify(keys) !== JSON.stringify(['authorizationId', 'path', 'rawSha256', 'semanticDigest']))
        return false;
    return typeof value.authorizationId === 'string'
        && typeof value.path === 'string'
        && typeof value.rawSha256 === 'string'
        && /^[a-f0-9]{64}$/u.test(value.rawSha256)
        && typeof value.semanticDigest === 'string'
        && /^[a-f0-9]{64}$/u.test(value.semanticDigest);
}
function authorizationRequirement(contract, requirementId) {
    const values = Array.isArray(contract.authorizationRequirements) ? contract.authorizationRequirements : [];
    const matches = values.filter((value) => (record(value)
        && value.id === requirementId
        && typeof value.action === 'string'
        && typeof value.target === 'string'
        && Array.isArray(value.scope)
        && value.scope.every((item) => typeof item === 'string')
        && typeof value.consumeOnce === 'boolean'));
    if (matches.length !== 1)
        throw new Error('ACCOUNTABILITY_AUTHORIZATION_REQUIREMENT_INVALID');
    return matches[0];
}
function acceptedContractReview(projectRoot, taskId, contractPath, contractRaw, contractDigest) {
    const path = safeAuthorizationPath(projectRoot, `.delivery/tasks/${taskId}/contract-review.yaml`);
    const review = parse(readFileSync(path, 'utf8'));
    if (!record(review) || !validateDocument('contract-review', review).valid)
        throw new Error('ACCOUNTABILITY_AUTHORIZATION_REVIEW_INVALID');
    const contract = record(review.contract) ? review.contract : {};
    if (review.taskId !== taskId
        || review.decision !== 'ACCEPTED'
        || contract.path !== contractPath
        || contract.rawSha256 !== sha256(contractRaw)
        || contract.digest !== contractDigest)
        throw new Error('ACCOUNTABILITY_AUTHORIZATION_REVIEW_BINDING_INVALID');
}
function loadBootstrap(projectRoot, taskId) {
    const path = safeAuthorizationPath(projectRoot, `.delivery/tasks/${taskId}/accountability-bootstrap.yaml`);
    const value = parse(readFileSync(path, 'utf8'));
    if (!record(value) || !validateDocument('accountability-bootstrap', value).valid || value.taskId !== taskId) {
        throw new Error('ACCOUNTABILITY_AUTHORIZATION_BOOTSTRAP_INVALID');
    }
    return value;
}
function initialBootstrapContext(projectRoot, reference, artifact, occurredAt) {
    if (artifact.projectRoot !== projectRoot)
        throw new Error('ACCOUNTABILITY_INITIAL_BOOTSTRAP_PROJECT_INVALID');
    if (!policyDigestAllowedForProject(projectRoot, artifact.policyDigest))
        throw new Error('ACCOUNTABILITY_INITIAL_BOOTSTRAP_POLICY_INVALID');
    if (artifact.authorizationId !== reference.authorizationId || canonicalDigest(artifact) !== reference.semanticDigest) {
        throw new Error('ACCOUNTABILITY_INITIAL_BOOTSTRAP_IDENTITY_INVALID');
    }
    if (sha256(JSON.stringify(artifact, null, 2) + '\n') !== reference.rawSha256) {
        throw new Error('ACCOUNTABILITY_INITIAL_BOOTSTRAP_RAW_MISMATCH');
    }
    const issued = Date.parse(artifact.issuedAt);
    const expires = Date.parse(artifact.expiresAt);
    if (!Number.isFinite(issued) || !Number.isFinite(expires) || expires <= issued) {
        throw new Error('ACCOUNTABILITY_INITIAL_BOOTSTRAP_TIME_INVALID');
    }
    const actorIds = artifact.actors.map((actor) => normalizeActorId(actor.actorId));
    if (new Set(actorIds).size !== actorIds.length)
        throw new Error('ACCOUNTABILITY_INITIAL_BOOTSTRAP_ACTOR_DUPLICATE');
    const aliases = new Set();
    for (const [index, actor] of artifact.actors.entries()) {
        const actorId = actorIds[index];
        const normalizedAliases = actor.aliases.map(normalizeActorId);
        if (normalizedAliases.includes(actorId) || normalizedAliases.some((alias) => aliases.has(alias))) {
            throw new Error('ACCOUNTABILITY_INITIAL_BOOTSTRAP_ALIAS_INVALID');
        }
        for (const alias of normalizedAliases)
            aliases.add(alias);
        actor.aliases = [...new Set(normalizedAliases)].sort();
        actor.actorId = actorId;
    }
    const requiredRoles = ['contract-author', 'contract-reviewer', 'implementation-reviewer', 'supervisor'];
    for (const role of requiredRoles) {
        if (artifact.actors.filter((actor) => actor.role === role).length !== 1) {
            throw new Error(`ACCOUNTABILITY_INITIAL_BOOTSTRAP_ROLE_INVALID:${role}`);
        }
    }
    if (!artifact.actors.some((actor) => actor.role === 'implementation-owner')) {
        throw new Error('ACCOUNTABILITY_INITIAL_BOOTSTRAP_ROLE_INVALID:implementation-owner');
    }
    const bootstrapActors = artifact.actors.map((actor) => ({
        actorId: actor.actorId,
        aliases: actor.aliases,
        lifetimePenaltyScore: 0,
        activePenaltyScore: 0,
        standing: 'GOOD_STANDING',
        permissions: permissionsForStanding('GOOD_STANDING'),
        unresolvedDefectClasses: [],
    }));
    const initialActorRoles = Object.fromEntries(artifact.actors.map((actor) => [actor.actorId, actor.role]));
    const actorForRole = (role) => artifact.actors.find((actor) => actor.role === role)?.actorId;
    const context = {
        reference,
        authorization: artifact,
        bootstrap: {
            taskId: artifact.bootstrapId,
            sources: [],
            findings: [],
            actors: bootstrapActors,
            remediationException: {},
        },
        contract: { taskId: artifact.bootstrapId, implementationOwner: actorForRole('implementation-owner') ?? '' },
        implementationOwner: actorForRole('implementation-owner') ?? '',
        implementationOwners: artifact.actors.filter((actor) => actor.role === 'implementation-owner').map((actor) => actor.actorId).sort(),
        supervisorId: actorForRole('supervisor'),
        contractReviewerId: actorForRole('contract-reviewer'),
        implementationReviewerId: actorForRole('implementation-reviewer'),
        initialBootstrap: true,
        initialActorRoles,
    };
    assertAuthorizationContextTime(context, occurredAt);
    return context;
}
function authorizationExceptionBinds(bootstrap, reference) {
    const exception = bootstrap.remediationException;
    if (exception.authorizationPath === reference.path) {
        return exception.authorizationRawSha256 === reference.rawSha256
            && exception.authorizationSemanticDigest === reference.semanticDigest;
    }
    if (exception.sidecarPath === reference.path) {
        return exception.sidecarRawSha256 === reference.rawSha256
            && exception.sidecarSemanticDigest === reference.semanticDigest;
    }
    if (exception.lifecycleAuthorizationPath === reference.path) {
        return exception.lifecycleAuthorizationRawSha256 === reference.rawSha256
            && exception.lifecycleAuthorizationSemanticDigest === reference.semanticDigest;
    }
    return false;
}
export function validateAuthorizationReference(projectRoot, value, occurredAt) {
    if (!exactAuthorizationReference(value))
        throw new Error('ACCOUNTABILITY_AUTHORIZATION_REFERENCE_INVALID');
    const root = realpathSync(resolve(projectRoot));
    const path = safeAuthorizationPath(root, value.path);
    const raw = readFileSync(path);
    if (sha256(raw) !== value.rawSha256)
        throw new Error('ACCOUNTABILITY_AUTHORIZATION_RAW_MISMATCH');
    let authorization;
    try {
        authorization = JSON.parse(raw.toString('utf8'));
    }
    catch {
        throw new Error('ACCOUNTABILITY_AUTHORIZATION_JSON_INVALID');
    }
    if (record(authorization) && authorization.artifactType === 'engineering-governance-initial-actor-bootstrap-v1') {
        const expectedPath = join(root, '.delivery', 'accountability', 'initial-bootstrap.json');
        if (path !== expectedPath)
            throw new Error('ACCOUNTABILITY_INITIAL_BOOTSTRAP_PATH_INVALID');
        if (!validateDocument('initial-actor-bootstrap', authorization).valid)
            throw new Error('ACCOUNTABILITY_INITIAL_BOOTSTRAP_SCHEMA_INVALID');
        return initialBootstrapContext(root, value, authorization, occurredAt);
    }
    if (!record(authorization) || !validateDocument('authorization', authorization).valid)
        throw new Error('ACCOUNTABILITY_AUTHORIZATION_SCHEMA_INVALID');
    if (authorization.authorizationId !== value.authorizationId || canonicalDigest(authorization) !== value.semanticDigest) {
        throw new Error('ACCOUNTABILITY_AUTHORIZATION_IDENTITY_INVALID');
    }
    if (!record(authorization.grantor)
        || normalizeActorId(String(authorization.grantor.id)) !== 'user-authority'
        || authorization.grantor.role !== 'user'
        || authorization.grantor.trustLevel !== 'local-claim'
        || authorization.status !== 'approved')
        throw new Error('ACCOUNTABILITY_AUTHORIZATION_GRANTOR_INVALID');
    if (typeof authorization.taskId !== 'string' || typeof authorization.requirementId !== 'string') {
        throw new Error('ACCOUNTABILITY_AUTHORIZATION_BINDING_INVALID');
    }
    safeTaskId(authorization.taskId);
    const contractPath = safeAuthorizationPath(root, `.delivery/tasks/${authorization.taskId}/contract.yaml`);
    const contractRaw = readFileSync(contractPath);
    const contract = parse(contractRaw.toString('utf8'));
    if (!record(contract) || !validateHardenedTaskContract(contract).valid || contract.taskId !== authorization.taskId || typeof contract.contractDigest !== 'string') {
        throw new Error('ACCOUNTABILITY_AUTHORIZATION_CONTRACT_INVALID');
    }
    const { contractDigest, ...unsignedContract } = contract;
    if (canonicalDigest(unsignedContract) !== contractDigest)
        throw new Error('ACCOUNTABILITY_AUTHORIZATION_CONTRACT_DIGEST_INVALID');
    const requirement = authorizationRequirement(contract, authorization.requirementId);
    const authorizationContract = record(authorization.contract) ? authorization.contract : undefined;
    const contractBindingValid = authorizationContract === undefined
        ? authorization.contractDigest === contractDigest
        : authorizationContract.path === contractPath
            && authorizationContract.rawSha256 === sha256(contractRaw)
            && authorizationContract.semanticDigest === contractDigest;
    if (!contractBindingValid
        || authorization.action !== requirement.action
        || requirement.target !== root
        || authorization.target !== root
        || !Array.isArray(authorization.scope)
        || !authorization.scope.every((item) => typeof item === 'string')
        || !sameStringSet(authorization.scope, requirement.scope)
        || (requirement.consumeOnce && authorization.consumeOnce !== true && authorization.artifactType !== 'sop-authorization-v2'))
        throw new Error('ACCOUNTABILITY_AUTHORIZATION_BINDING_INVALID');
    acceptedContractReview(root, authorization.taskId, contractPath, contractRaw, contractDigest);
    const bootstrap = loadBootstrap(root, authorization.taskId);
    if (!authorizationExceptionBinds(bootstrap, value))
        throw new Error('ACCOUNTABILITY_AUTHORIZATION_BOOTSTRAP_BINDING_INVALID');
    const context = {
        reference: value,
        authorization,
        bootstrap,
        contract,
        implementationOwner: implementationOwnersOf(contract)[0],
        implementationOwners: implementationOwnersOf(contract),
        supervisorId: typeof authorization.supervisorId === 'string' ? normalizeActorId(authorization.supervisorId) : undefined,
        contractReviewerId: typeof authorization.contractReviewerId === 'string' ? normalizeActorId(authorization.contractReviewerId) : undefined,
        implementationReviewerId: typeof authorization.implementationReviewerId === 'string' ? normalizeActorId(authorization.implementationReviewerId) : undefined,
    };
    assertAuthorizationContextTime(context, occurredAt);
    return context;
}
function expectedRole(context, actorId) {
    const initialRole = context.initialActorRoles?.[actorId];
    if (initialRole !== undefined)
        return initialRole;
    if (context.implementationOwners.includes(actorId))
        return 'implementation-owner';
    if (actorId === context.supervisorId)
        return 'supervisor';
    if (actorId === context.contractReviewerId)
        return 'contract-reviewer';
    if (actorId === context.implementationReviewerId)
        return 'implementation-reviewer';
    for (const source of context.bootstrap.sources.filter((candidate) => candidate.kind === 'review')) {
        try {
            const path = isAbsolute(source.path) ? source.path : resolve(String(context.authorization.target), source.path);
            const review = parse(readFileSync(path, 'utf8'));
            if (record(review) && record(review.reviewer) && normalizeActorId(String(review.reviewer.id)) === actorId)
                return 'contract-reviewer';
        }
        catch { /* source identity is independently validated by bootstrap verification */ }
    }
    if (actorId.includes('implementation-reviewer'))
        return 'implementation-reviewer';
    if (actorId.includes('contract-reviewer'))
        return 'contract-reviewer';
    return undefined;
}
function parseEvent(projectRoot, line, sequence, previous) {
    let decoded;
    try {
        decoded = JSON.parse(line);
    }
    catch {
        throw new Error('ACCOUNTABILITY_REGISTRY_JSON_INVALID');
    }
    if (!record(decoded) || !validateDocument('actor-registry-event', decoded).valid)
        throw new Error('ACCOUNTABILITY_REGISTRY_SCHEMA_INVALID');
    const parsed = decoded;
    if (parsed.sequence !== sequence)
        throw new Error('ACCOUNTABILITY_REGISTRY_SEQUENCE_INVALID');
    const { eventDigest, ...unsigned } = parsed;
    if (canonicalEventDigest(unsigned) !== eventDigest)
        throw new Error('ACCOUNTABILITY_REGISTRY_DIGEST_INVALID');
    const expectedPrevious = previous?.eventDigest ?? ACCOUNTABILITY_GENESIS_DIGEST;
    if (parsed.priorEventDigest !== expectedPrevious)
        throw new Error('ACCOUNTABILITY_REGISTRY_CHAIN_INVALID');
    if (!policyDigestAllowedForProject(projectRoot, parsed.policyDigest))
        throw new Error('ACCOUNTABILITY_REGISTRY_POLICY_INVALID');
    if (previous !== undefined && Date.parse(parsed.occurredAt) < Date.parse(previous.occurredAt))
        throw new Error('ACCOUNTABILITY_REGISTRY_TIME_ORDER_INVALID');
    const actorId = normalizeActorId(parsed.actorId);
    const aliases = parsed.aliases.map(normalizeActorId);
    if (normalizeActorId(parsed.actor.id) !== actorId)
        throw new Error('ACCOUNTABILITY_REGISTRY_ACTOR_BINDING_INVALID');
    if (new Set(aliases).size !== aliases.length || aliases.includes(actorId))
        throw new Error('ACCOUNTABILITY_ALIAS_INVALID');
    return { ...parsed, actorId, aliases: [...aliases].sort() };
}
function applyRegistryEvent(projectRoot, event, actors, aliases, priorEvents, authorizationContexts) {
    const actorId = event.actorId;
    const current = actors.get(actorId);
    if ((event.eventType === 'actor_created' && current !== undefined)
        || (event.eventType === 'alias_added' && (current === undefined || !current.active))
        || (event.eventType === 'actor_revoked' && (current === undefined || !current.active))
        || (event.eventType === 'actor_restored' && (current === undefined || current.active)))
        throw new Error('ACCOUNTABILITY_REGISTRY_TRANSITION_INVALID');
    if (current !== undefined) {
        if (event.actor.role !== current.role || event.actor.trustLevel !== current.trustLevel)
            throw new Error('ACCOUNTABILITY_REGISTRY_TRANSITION_INVALID');
        const before = JSON.stringify([...current.aliases].sort());
        const after = JSON.stringify([...event.aliases].sort());
        if (event.eventType === 'alias_added') {
            if (before === after || current.aliases.some((alias) => !event.aliases.includes(alias)))
                throw new Error('ACCOUNTABILITY_REGISTRY_TRANSITION_INVALID');
        }
        else if (before !== after)
            throw new Error('ACCOUNTABILITY_REGISTRY_TRANSITION_INVALID');
    }
    const authorizationKey = JSON.stringify(event.authorization);
    let context = authorizationContexts.get(authorizationKey);
    if (context === undefined) {
        context = validateAuthorizationReference(projectRoot, event.authorization, event.occurredAt);
        authorizationContexts.set(authorizationKey, context);
    }
    else
        assertAuthorizationContextTime(context, event.occurredAt);
    if (context.initialBootstrap && (event.eventType !== 'actor_created' || event.sequence > context.bootstrap.actors.length)) {
        throw new Error('ACCOUNTABILITY_INITIAL_BOOTSTRAP_REPLAYED');
    }
    const bootstrapActor = context.bootstrap.actors.find((actor) => normalizeActorId(actor.actorId) === actorId);
    if (bootstrapActor === undefined)
        throw new Error('ACCOUNTABILITY_REGISTRY_ACTOR_NOT_AUTHORIZED');
    const allowedAliases = bootstrapActor.aliases.map(normalizeActorId).sort();
    if (event.aliases.some((alias) => !allowedAliases.includes(alias)))
        throw new Error('ACCOUNTABILITY_REGISTRY_ALIAS_NOT_AUTHORIZED');
    const role = expectedRole(context, actorId);
    if (role === undefined || event.actor.role !== role)
        throw new Error('ACCOUNTABILITY_REGISTRY_ROLE_NOT_AUTHORIZED');
    if (event.eventType !== 'actor_created') {
        const reused = priorEvents.some((prior) => record(prior.authorization) && prior.authorization.authorizationId === context.reference.authorizationId);
        if (reused)
            throw new Error('ACCOUNTABILITY_AUTHORIZATION_REPLAYED');
    }
    for (const alias of event.aliases) {
        const owner = aliases.get(alias);
        if (owner !== undefined && owner !== actorId)
            throw new Error('ACCOUNTABILITY_ALIAS_DUPLICATE');
        aliases.set(alias, actorId);
    }
    const active = event.eventType === 'actor_revoked' ? false : event.eventType === 'actor_restored' ? true : current?.active ?? true;
    actors.set(actorId, {
        actorId,
        aliases: [...event.aliases],
        role: event.actor.role,
        trustLevel: event.actor.trustLevel,
        active,
        sequence: event.sequence,
        eventDigest: event.eventDigest,
    });
}
export function readActorRegistry(projectRoot, authorizationContexts = new Map()) {
    assertAccountabilityPolicy(projectRoot);
    const path = registryPath(projectRoot);
    if (!existsSync(path))
        return { events: [], actors: [] };
    if (lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile() || realpathSync(path) !== path)
        throw new Error('ACCOUNTABILITY_REGISTRY_UNSAFE');
    const events = [];
    const actors = new Map();
    const aliases = new Map();
    const lines = readFileSync(path, 'utf8').split('\n').filter((line) => line.length > 0);
    for (const [index, line] of lines.entries()) {
        const event = parseEvent(projectRoot, line, index + 1, events.at(-1));
        applyRegistryEvent(projectRoot, event, actors, aliases, events, authorizationContexts);
        events.push(event);
    }
    for (const context of authorizationContexts.values()) {
        if (!context.initialBootstrap)
            continue;
        const initialEvents = events.filter((event) => JSON.stringify(event.authorization) === JSON.stringify(context.reference));
        const expectedIds = new Set(context.bootstrap.actors.map((actor) => normalizeActorId(actor.actorId)));
        const actualIds = new Set(initialEvents.map((event) => normalizeActorId(event.actorId)));
        if (initialEvents.length !== expectedIds.size || actualIds.size !== expectedIds.size || [...expectedIds].some((actorId) => !actualIds.has(actorId))) {
            throw new Error('ACCOUNTABILITY_INITIAL_BOOTSTRAP_INCOMPLETE');
        }
    }
    return { events, actors: [...actors.values()].sort((left, right) => left.actorId.localeCompare(right.actorId)) };
}
export function resolveRegisteredActor(projectRoot, actorOrAlias) {
    const normalized = normalizeActorId(actorOrAlias);
    const registry = readActorRegistry(projectRoot);
    const actor = registry.actors.find((candidate) => candidate.actorId === normalized || candidate.aliases.includes(normalized));
    if (actor === undefined || !actor.active)
        throw new Error('ACCOUNTABILITY_ACTOR_UNAVAILABLE');
    return actor;
}
export function appendActorRegistryEvent(projectRoot, event, authorization) {
    const current = readActorRegistry(projectRoot);
    const unsigned = {
        ...event,
        authorization,
        actorId: normalizeActorId(event.actorId),
        aliases: event.aliases.map(normalizeActorId).sort(),
        sequence: current.events.length + 1,
        priorEventDigest: current.events.at(-1)?.eventDigest ?? ACCOUNTABILITY_GENESIS_DIGEST,
        policyDigest: policyDigestForProject(projectRoot),
    };
    const result = { ...unsigned, eventDigest: canonicalEventDigest(unsigned) };
    const actors = new Map(current.actors.map((actor) => [actor.actorId, actor]));
    const aliases = new Map();
    for (const actor of actors.values())
        for (const alias of actor.aliases)
            aliases.set(alias, actor.actorId);
    applyRegistryEvent(projectRoot, result, actors, aliases, current.events, new Map());
    const root = realpathSync(resolve(projectRoot));
    const parent = join(root, '.delivery', 'accountability');
    mkdirSync(parent, { recursive: true, mode: 0o755 });
    appendFileSync(registryPath(root), `${JSON.stringify(result)}\n`, { mode: 0o644 });
    return result;
}
export function assertContainedAuthorityPath(projectRoot, candidate) {
    return safeAuthorizationPath(projectRoot, candidate);
}
export function accountabilityGenesisValid() {
    return sha256(ACCOUNTABILITY_GENESIS_BYTES) === ACCOUNTABILITY_GENESIS_DIGEST;
}
export function policyDigestForProject(projectRoot) {
    const policy = parse(readFileSync(join(realpathSync(resolve(projectRoot)), '.delivery', 'policy.yaml'), 'utf8'));
    if (typeof policy.sopDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(policy.sopDigest))
        throw new Error('ACCOUNTABILITY_POLICY_DIGEST_INVALID');
    return policy.sopDigest;
}
export function policyDigestsForProject(projectRoot) {
    const policy = parse(readFileSync(join(realpathSync(resolve(projectRoot)), '.delivery', 'policy.yaml'), 'utf8'));
    const current = policyDigestForProject(projectRoot);
    const lineage = record(policy.artifactMapping)
        ? policy.artifactMapping['accountability.policyLineage']
        : undefined;
    const historical = typeof lineage === 'string'
        ? lineage.split(',').map((value) => value.trim()).filter((value) => /^[a-f0-9]{64}$/u.test(value))
        : [];
    return new Set([current, ...historical]);
}
export function policyDigestAllowedForProject(projectRoot, digest) {
    return policyDigestsForProject(projectRoot).has(digest);
}
