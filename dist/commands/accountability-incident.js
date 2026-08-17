import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { extname, isAbsolute, join, relative, resolve } from 'node:path';
import { parse } from 'yaml';
import { deriveAccountabilityStatus, readAccountabilityEvents, } from '../accountability/derive.js';
import { ACCOUNTABILITY_EVENTS_PATH, ACCOUNTABILITY_GENESIS_DIGEST, assertAccountabilityPolicy, permissionsForStanding, scoreForFinding, standingForScore, } from '../accountability/policy.js';
import { policyDigestForProject, readActorRegistry } from '../accountability/registry.js';
import { normalizeActorId } from '../model/actor.js';
import { canonicalDigest } from '../model/digest.js';
import { validateDocument } from '../policy/load.js';
import { applyPlannedWrites, assertPlannedGuardsUnchanged, } from '../project/mutate.js';
function sha256(value) {
    return createHash('sha256').update(value).digest('hex');
}
function record(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function currentDigest(path) {
    if (!existsSync(path))
        return null;
    if (lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile())
        throw new Error(`ACCOUNTABILITY_INCIDENT_PATH_UNSAFE:${path}`);
    return sha256(readFileSync(path));
}
function guard(path) {
    return { path, beforeDigest: currentDigest(path) };
}
function sourceSemantic(path, raw) {
    if (path.endsWith('.jsonl')) {
        try {
            return canonicalDigest(raw.toString('utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)));
        }
        catch {
            throw new Error('ACCOUNTABILITY_INCIDENT_EVIDENCE_INVALID');
        }
    }
    if (['.yaml', '.yml', '.json'].includes(extname(path))) {
        try {
            return canonicalDigest(parse(raw.toString('utf8')));
        }
        catch {
            throw new Error('ACCOUNTABILITY_INCIDENT_EVIDENCE_INVALID');
        }
    }
    return canonicalDigest(raw.toString('utf8'));
}
function evidencePath(projectRoot, path) {
    if (isAbsolute(path))
        throw new Error('ACCOUNTABILITY_INCIDENT_EVIDENCE_PATH_INVALID');
    const unresolved = resolve(projectRoot, path);
    if (relative(projectRoot, unresolved) !== path
        || !existsSync(unresolved)
        || lstatSync(unresolved).isSymbolicLink()
        || !lstatSync(unresolved).isFile()
        || realpathSync(unresolved) !== unresolved) {
        throw new Error('ACCOUNTABILITY_INCIDENT_EVIDENCE_PATH_INVALID');
    }
    return unresolved;
}
function normalizeIncident(value, projectRoot) {
    const schema = validateDocument('accountability-incident', value);
    if (!schema.valid || !record(value))
        throw new Error(`ACCOUNTABILITY_INCIDENT_SCHEMA_INVALID:${schema.errors.join(',')}`);
    const incident = value;
    if (realpathSync(resolve(incident.projectRoot)) !== projectRoot)
        throw new Error('ACCOUNTABILITY_INCIDENT_PROJECT_INVALID');
    const issued = Date.parse(incident.issuedAt);
    const expires = Date.parse(incident.expiresAt);
    const observed = Date.parse(incident.failureContext.observedAt);
    if (!Number.isFinite(issued) || !Number.isFinite(expires) || !Number.isFinite(observed) || expires <= issued || observed > issued) {
        throw new Error('ACCOUNTABILITY_INCIDENT_TIME_INVALID');
    }
    const evidenceRefs = incident.evidenceRefs.map((reference) => ({ ...reference })).sort((left, right) => left.path.localeCompare(right.path));
    if (new Set(evidenceRefs.map((reference) => reference.path)).size !== evidenceRefs.length)
        throw new Error('ACCOUNTABILITY_INCIDENT_EVIDENCE_DUPLICATED');
    for (const reference of evidenceRefs) {
        const path = evidencePath(projectRoot, reference.path);
        const raw = readFileSync(path);
        if (sha256(raw) !== reference.rawSha256 || sourceSemantic(path, raw) !== reference.semanticDigest) {
            throw new Error(`ACCOUNTABILITY_INCIDENT_EVIDENCE_IDENTITY_MISMATCH:${reference.path}`);
        }
    }
    if (incident.finding.culpability === 'culpable' && incident.finding.responsibleRole === 'none') {
        throw new Error('ACCOUNTABILITY_INCIDENT_RESPONSIBILITY_INVALID');
    }
    return {
        ...incident,
        projectRoot,
        subjectActorId: normalizeActorId(incident.subjectActorId),
        reportedBy: incident.reportedBy === 'user-authority' ? 'user-authority' : normalizeActorId(incident.reportedBy),
        evidenceRefs,
    };
}
function planDigest(plan) {
    return canonicalDigest({
        schemaVersion: plan.schemaVersion,
        artifactType: plan.artifactType,
        projectRoot: plan.projectRoot,
        inputPath: plan.inputPath,
        event: plan.event,
        writes: plan.writes.map((write) => ({ path: write.path, beforeDigest: write.beforeDigest, afterDigest: sha256(write.after), mode: write.mode })),
        guards: plan.guards,
    });
}
export function planAccountabilityIncident(projectRootInput, inputPathInput) {
    const projectRoot = realpathSync(resolve(projectRootInput));
    const inputPath = realpathSync(resolve(inputPathInput));
    assertAccountabilityPolicy(projectRoot);
    const incident = normalizeIncident(parse(readFileSync(inputPath, 'utf8')), projectRoot);
    const registry = readActorRegistry(projectRoot);
    const activeActors = new Set(registry.actors.filter((actor) => actor.active).map((actor) => actor.actorId));
    if (!activeActors.has(incident.subjectActorId))
        throw new Error('ACCOUNTABILITY_INCIDENT_SUBJECT_UNAVAILABLE');
    if (incident.reportedBy !== 'user-authority' && !activeActors.has(incident.reportedBy))
        throw new Error('ACCOUNTABILITY_INCIDENT_REPORTER_UNAVAILABLE');
    const currentEvents = readAccountabilityEvents(projectRoot);
    if (currentEvents.some((event) => event.incident?.incidentId === incident.incidentId))
        throw new Error('ACCOUNTABILITY_INCIDENT_DUPLICATED');
    const previous = currentEvents.at(-1);
    if (previous !== undefined && Date.parse(incident.issuedAt) < Date.parse(previous.occurredAt))
        throw new Error('ACCOUNTABILITY_INCIDENT_TIME_ORDER_INVALID');
    const priorOffenses = new Map();
    for (const event of currentEvents.filter((event) => event.subjectActorId === incident.subjectActorId && event.eventType === 'finding_assessed')) {
        const defectClass = event.scoreChange?.defectClass;
        if (defectClass !== undefined)
            priorOffenses.set(defectClass, (priorOffenses.get(defectClass) ?? 0) + 1);
    }
    const score = scoreForFinding(incident.finding.severity, incident.finding.defectClass, priorOffenses, incident.finding.classification, incident.finding.culpability);
    const status = deriveAccountabilityStatus(projectRoot, incident.subjectActorId);
    const lifetimePenaltyScore = status.lifetimePenaltyScore + score.delta;
    const activePenaltyScore = status.activePenaltyScore + score.delta;
    const forcedSuspended = (status.standing === 'SUSPENDED' && status.activePenaltyScore < 12) || score.immediateSuspension;
    const standing = standingForScore(activePenaltyScore, forcedSuspended);
    const sourceRaw = `${JSON.stringify(incident, null, 2)}\n`;
    const unsigned = {
        schemaVersion: 1,
        artifactType: 'engineering-governance-accountability-event-v1',
        eventType: 'finding_assessed',
        sequence: currentEvents.length + 1,
        priorEventDigest: previous?.eventDigest ?? ACCOUNTABILITY_GENESIS_DIGEST,
        policyDigest: policyDigestForProject(projectRoot),
        subjectActorId: incident.subjectActorId,
        source: {
            taskId: `incident:${incident.incidentId}`,
            artifactPath: `embedded://accountability-incident/${incident.incidentId}`,
            rawSha256: sha256(sourceRaw),
            semanticDigest: canonicalDigest(incident),
            reviewId: `incident:${incident.incidentId}`,
            findingId: incident.finding.findingId,
        },
        score: { base: score.base, repeatSurcharge: score.repeatSurcharge, immediateSuspension: score.immediateSuspension, delta: score.delta },
        scoreChange: {
            delta: score.delta,
            reason: 'finding',
            isFirstOffense: score.isFirstOffense,
            isRepeatOffense: !score.isFirstOffense,
            repeatCount: score.repeatCount,
            defectClass: score.defectClass,
        },
        lifetimePenaltyScore,
        activePenaltyScore,
        standing,
        permissions: permissionsForStanding(standing),
        authorization: 'none',
        incident,
        occurredAt: incident.issuedAt,
    };
    const event = { ...unsigned, eventDigest: canonicalDigest(unsigned) };
    const eventSchema = validateDocument('accountability-event', event);
    if (!eventSchema.valid)
        throw new Error(`ACCOUNTABILITY_INCIDENT_EVENT_SCHEMA_INVALID:${eventSchema.errors.join(',')}`);
    const eventsPath = join(projectRoot, ACCOUNTABILITY_EVENTS_PATH);
    const existing = existsSync(eventsPath) ? readFileSync(eventsPath, 'utf8') : '';
    const writes = [{ path: eventsPath, beforeDigest: currentDigest(eventsPath), after: `${existing}${JSON.stringify(event)}\n`, mode: 0o644 }];
    const guards = [
        guard(inputPath),
        guard(join(projectRoot, '.delivery', 'policy.yaml')),
        guard(join(projectRoot, '.delivery', 'accountability', 'actors.jsonl')),
        guard(eventsPath),
        ...incident.evidenceRefs.map((reference) => guard(evidencePath(projectRoot, reference.path))),
    ];
    const withoutDigest = {
        schemaVersion: 1,
        artifactType: 'engineering-governance-accountability-incident-plan-v1',
        projectRoot,
        inputPath,
        event,
        writes,
        guards,
    };
    return { ...withoutDigest, digest: planDigest(withoutDigest) };
}
export function summarizeAccountabilityIncidentPlan(plan) {
    return {
        schemaVersion: plan.schemaVersion,
        artifactType: plan.artifactType,
        projectRoot: plan.projectRoot,
        inputPath: plan.inputPath,
        incidentId: plan.event.incident?.incidentId,
        subjectActorId: plan.event.subjectActorId,
        scoreDelta: plan.event.score.delta,
        standing: plan.event.standing,
        eventDigest: plan.event.eventDigest,
        digest: plan.digest,
        writes: plan.writes.map((write) => ({ path: write.path, beforeDigest: write.beforeDigest, afterDigest: sha256(write.after), mode: write.mode })),
    };
}
export function applyAccountabilityIncident(plan, expectedDigest) {
    if (plan.digest !== expectedDigest || planDigest({
        schemaVersion: plan.schemaVersion,
        artifactType: plan.artifactType,
        projectRoot: plan.projectRoot,
        inputPath: plan.inputPath,
        event: plan.event,
        writes: plan.writes,
        guards: plan.guards,
    }) !== plan.digest)
        throw new Error('ACCOUNTABILITY_INCIDENT_PLAN_MISMATCH');
    assertPlannedGuardsUnchanged(plan.guards);
    const result = applyPlannedWrites(plan.writes, { dryRun: false });
    const event = readAccountabilityEvents(plan.projectRoot).at(-1);
    if (event?.eventDigest !== plan.event.eventDigest)
        throw new Error('ACCOUNTABILITY_INCIDENT_RESULT_INVALID');
    return {
        digest: plan.digest,
        applied: result.applied,
        event,
        status: deriveAccountabilityStatus(plan.projectRoot, plan.event.subjectActorId),
    };
}
