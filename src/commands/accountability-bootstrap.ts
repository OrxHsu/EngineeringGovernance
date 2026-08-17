import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { parse } from 'yaml'

import {
  policyDigestForProject,
  type AuthorizationReference,
  readActorRegistry,
} from '../accountability/registry.js'
import { canonicalDigest } from '../model/digest.js'
import { normalizeActorId } from '../model/actor.js'
import { validateDocument } from '../policy/load.js'
import { ACCOUNTABILITY_GENESIS_DIGEST, assertAccountabilityPolicy } from '../accountability/policy.js'
import {
  applyPlannedWrites,
  assertPlannedGuardsUnchanged,
  type PlannedGuard,
  type PlannedWrite,
} from '../project/mutate.js'

interface InitialActorBootstrapInput {
  schemaVersion: 1
  artifactType: 'engineering-governance-initial-actor-bootstrap-v1'
  bootstrapId: string
  authorizationId: string
  projectRoot: string
  policyDigest: string
  grantor: { id: 'user-authority'; role: 'user'; trustLevel: 'local-claim' }
  issuedAt: string
  expiresAt: string
  status: 'approved'
  actors: Array<{ actorId: string; aliases: string[]; role: string }>
}

interface InitialActorBootstrapPlan {
  projectRoot: string
  inputPath: string
  writes: PlannedWrite[]
  guards: PlannedGuard[]
  digest: string
  authorizationReference: AuthorizationReference
  actorIds: string[]
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

function currentDigest(path: string): string | null {
  if (!existsSync(path)) return null
  if (lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile()) throw new Error(`ACCOUNTABILITY_INITIAL_BOOTSTRAP_PATH_UNSAFE:${path}`)
  return sha256(readFileSync(path))
}

function guard(path: string): PlannedGuard {
  return { path, beforeDigest: currentDigest(path) }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizeInput(value: InitialActorBootstrapInput, projectRoot: string): InitialActorBootstrapInput {
  if (!record(value) || !validateDocument('initial-actor-bootstrap', value).valid) {
    throw new Error('ACCOUNTABILITY_INITIAL_BOOTSTRAP_SCHEMA_INVALID')
  }
  if (realpathSync(resolve(value.projectRoot)) !== projectRoot) throw new Error('ACCOUNTABILITY_INITIAL_BOOTSTRAP_PROJECT_INVALID')
  if (value.policyDigest !== policyDigestForProject(projectRoot)) throw new Error('ACCOUNTABILITY_INITIAL_BOOTSTRAP_POLICY_INVALID')
  const issued = Date.parse(value.issuedAt)
  const expires = Date.parse(value.expiresAt)
  if (!Number.isFinite(issued) || !Number.isFinite(expires) || expires <= issued) throw new Error('ACCOUNTABILITY_INITIAL_BOOTSTRAP_TIME_INVALID')
  const actorIds = value.actors.map((actor) => normalizeActorId(actor.actorId))
  if (new Set(actorIds).size !== actorIds.length) throw new Error('ACCOUNTABILITY_INITIAL_BOOTSTRAP_ACTOR_DUPLICATE')
  const aliases = new Set<string>()
  const actors = value.actors.map((actor, index) => {
    const actorId = actorIds[index]!
    const normalizedAliases = actor.aliases.map(normalizeActorId).sort()
    if (normalizedAliases.includes(actorId) || normalizedAliases.some((alias) => aliases.has(alias))) throw new Error('ACCOUNTABILITY_INITIAL_BOOTSTRAP_ALIAS_INVALID')
    for (const alias of normalizedAliases) aliases.add(alias)
    return { actorId, aliases: normalizedAliases, role: actor.role }
  }).sort((left, right) => left.actorId.localeCompare(right.actorId))
  for (const role of ['contract-author', 'contract-reviewer', 'implementation-reviewer', 'supervisor']) {
    if (actors.filter((actor) => actor.role === role).length !== 1) throw new Error(`ACCOUNTABILITY_INITIAL_BOOTSTRAP_ROLE_INVALID:${role}`)
  }
  if (!actors.some((actor) => actor.role === 'implementation-owner')) throw new Error('ACCOUNTABILITY_INITIAL_BOOTSTRAP_ROLE_INVALID:implementation-owner')
  return { ...value, projectRoot, actors }
}

function planDigest(plan: Omit<InitialActorBootstrapPlan, 'digest'>): string {
  return sha256(JSON.stringify({
    projectRoot: plan.projectRoot,
    inputPath: plan.inputPath,
    writes: plan.writes.map((write) => ({
      path: write.path,
      beforeDigest: write.beforeDigest,
      afterDigest: sha256(write.after),
      mode: write.mode,
    })),
    guards: plan.guards,
    authorizationReference: plan.authorizationReference,
    actorIds: plan.actorIds,
  }))
}

export function planAccountabilityBootstrap(projectRootInput: string, inputPathInput: string): InitialActorBootstrapPlan {
  const projectRoot = realpathSync(resolve(projectRootInput))
  const inputPath = realpathSync(resolve(inputPathInput))
  assertAccountabilityPolicy(projectRoot)
  const inputRaw = readFileSync(inputPath)
  let decoded: unknown
  try { decoded = parse(inputRaw.toString('utf8')) } catch { throw new Error('ACCOUNTABILITY_INITIAL_BOOTSTRAP_INPUT_INVALID') }
  const input = normalizeInput(decoded as InitialActorBootstrapInput, projectRoot)
  const parent = join(projectRoot, '.delivery', 'accountability')
  if (existsSync(parent) && (lstatSync(parent).isSymbolicLink() || !lstatSync(parent).isDirectory())) throw new Error('ACCOUNTABILITY_INITIAL_BOOTSTRAP_PARENT_UNSAFE')
  const artifactPath = join(parent, 'initial-bootstrap.json')
  const registryPath = join(parent, 'actors.jsonl')
  const eventsPath = join(parent, 'events.jsonl')
  if (existsSync(artifactPath) || existsSync(registryPath)) throw new Error('ACCOUNTABILITY_INITIAL_BOOTSTRAP_ALREADY_EXISTS')
  if (existsSync(eventsPath) && readFileSync(eventsPath).length > 0) throw new Error('ACCOUNTABILITY_INITIAL_BOOTSTRAP_EVENTS_PRESENT')

  const artifactRaw = `${JSON.stringify(input, null, 2)}\n`
  const authorizationReference: AuthorizationReference = {
    authorizationId: input.authorizationId,
    path: '.delivery/accountability/initial-bootstrap.json',
    rawSha256: sha256(artifactRaw),
    semanticDigest: canonicalDigest(input),
  }
  let priorEventDigest = ACCOUNTABILITY_GENESIS_DIGEST
  const lines: string[] = []
  for (const [index, actor] of input.actors.entries()) {
    const unsigned = {
      schemaVersion: 1 as const,
      artifactType: 'engineering-governance-actor-registry-event-v1' as const,
      eventType: 'actor_created' as const,
      sequence: index + 1,
      priorEventDigest,
      policyDigest: input.policyDigest,
      actorId: actor.actorId,
      aliases: actor.aliases,
      authorization: authorizationReference,
      actor: { id: actor.actorId, role: actor.role, trustLevel: 'local-claim' as const },
      occurredAt: input.issuedAt,
    }
    const event = { ...unsigned, eventDigest: canonicalDigest(unsigned) }
    if (!validateDocument('actor-registry-event', event).valid) throw new Error('ACCOUNTABILITY_INITIAL_BOOTSTRAP_EVENT_INVALID')
    lines.push(JSON.stringify(event))
    priorEventDigest = event.eventDigest
  }
  const writes: PlannedWrite[] = [
    { path: artifactPath, beforeDigest: null, after: artifactRaw, mode: 0o644 },
    { path: registryPath, beforeDigest: null, after: `${lines.join('\n')}\n`, mode: 0o644 },
  ]
  const guards = [guard(inputPath), guard(join(projectRoot, '.delivery', 'policy.yaml')), guard(artifactPath), guard(registryPath), guard(eventsPath)]
  const withoutDigest = { projectRoot, inputPath, writes, guards, authorizationReference, actorIds: input.actors.map((actor) => actor.actorId) }
  return { ...withoutDigest, digest: planDigest(withoutDigest) }
}

export function summarizeAccountabilityBootstrapPlan(plan: InitialActorBootstrapPlan): object {
  return {
    projectRoot: plan.projectRoot,
    inputPath: plan.inputPath,
    digest: plan.digest,
    actorIds: plan.actorIds,
    authorizationReference: plan.authorizationReference,
    writes: plan.writes.map((write) => ({ path: write.path, beforeDigest: write.beforeDigest, afterDigest: sha256(write.after), mode: write.mode })),
    guards: plan.guards,
  }
}

export function applyAccountabilityBootstrap(plan: InitialActorBootstrapPlan, expectedDigest: string): object {
  if (plan.digest !== expectedDigest) throw new Error('ACCOUNTABILITY_INITIAL_BOOTSTRAP_PLAN_MISMATCH')
  assertPlannedGuardsUnchanged(plan.guards)
  const result = applyPlannedWrites(plan.writes, { dryRun: false })
  const registry = readActorRegistry(plan.projectRoot)
  if (registry.actors.length !== plan.actorIds.length) throw new Error('ACCOUNTABILITY_INITIAL_BOOTSTRAP_RESULT_INVALID')
  return { digest: plan.digest, applied: result.applied, actors: registry.actors }
}
