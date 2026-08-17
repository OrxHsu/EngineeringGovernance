import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { accountabilityGenesisValid, policyDigestsForProject, readActorRegistry, resolveRegisteredActor } from '../../src/accountability/registry.js'
import { canonicalDigest } from '../../src/model/digest.js'
import { rebindAccountabilityFixture } from '../helpers/accountability-fixture.js'

const projectRoot = process.cwd()
const temporary: string[] = []

function fixture(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'actor-registry-boundary-')))
  temporary.push(root)
  mkdirSync(join(root, '.delivery', 'accountability'), { recursive: true })
  mkdirSync(join(root, '.delivery', 'tasks'), { recursive: true })
  cpSync(join(projectRoot, '.delivery', 'policy.yaml'), join(root, '.delivery', 'policy.yaml'))
  cpSync(join(projectRoot, '.delivery', 'bin'), join(root, '.delivery', 'bin'), { recursive: true })
  cpSync(
    join(projectRoot, '.delivery', 'tasks', 'global-sop-2-1-beta-1-fix-1-repair-3'),
    join(root, '.delivery', 'tasks', 'global-sop-2-1-beta-1-fix-1-repair-3'),
    { recursive: true },
  )
  cpSync(
    join(projectRoot, '.delivery', 'accountability', 'actors.jsonl'),
    join(root, '.delivery', 'accountability', 'actors.jsonl'),
  )
  rebindAccountabilityFixture(root, projectRoot)
  return root
}

function appendRegistryEvent(root: string, overrides: Record<string, unknown>): void {
  const path = join(root, '.delivery', 'accountability', 'actors.jsonl')
  const events = readFileSync(path, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>)
  const unsigned = {
    schemaVersion: 1,
    artifactType: 'engineering-governance-actor-registry-event-v1',
    eventType: 'actor_created',
    sequence: events.length + 1,
    priorEventDigest: events.at(-1)!.eventDigest,
    policyDigest: '258befcfe9f8d24f8ba031e8a99941043e7fbfaba557a16949b10169fd02205f',
    actorId: 'forged-owner',
    aliases: [],
    authorization: 'none',
    actor: { id: 'forged-owner', role: 'implementation-owner', trustLevel: 'local-claim' },
    occurredAt: '2026-08-16T02:47:00.000Z',
    ...overrides,
  }
  appendFileSync(path, `${JSON.stringify({ ...unsigned, eventDigest: canonicalDigest(unsigned) })}\n`)
}

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('strict-v1 actor registry', () => {
  it('derives canonical actors from the policy-anchored append-only registry', () => {
    const registry = readActorRegistry(process.cwd())
    expect(accountabilityGenesisValid()).toBe(true)
    expect(registry.events.length).toBeGreaterThanOrEqual(5)
    expect(resolveRegisteredActor(process.cwd(), ' CODEX ').actorId).toBe('codex')
    expect(resolveRegisteredActor(process.cwd(), 'independent-implementation-reviewer-fix1').active).toBe(true)
  })

  it('rejects an unknown actor instead of trusting the caller string', () => {
    expect(() => resolveRegisteredActor(process.cwd(), 'caller-selected-admin')).toThrow('ACCOUNTABILITY_ACTOR_UNAVAILABLE')
  })

  it('rejects a forged actor event with an unbound policy digest and no user authorization', () => {
    const root = fixture()
    appendRegistryEvent(root, { policyDigest: '0'.repeat(64) })
    expect(() => readActorRegistry(root)).toThrow('ACCOUNTABILITY_REGISTRY_POLICY_INVALID')
  })

  it('returns current plus explicitly declared historical policy digests', () => {
    const root = fixture()
    const policyPath = join(root, '.delivery', 'policy.yaml')
    const policy = readFileSync(policyPath, 'utf8')
    const current = policy.match(/^sopDigest: (.+)$/m)?.[1]
    if (current === undefined) throw new Error('test policy digest missing')
    const updated = policy
      .replace(/^sopDigest: .+$/m, `sopDigest: ${'a'.repeat(64)}`)
      .replace(/^(  accountability\.genesisDigest: .+)$/m, `$1\n  accountability.policyLineage: ${current}`)
    writeFileSync(policyPath, updated)
    expect(policyDigestsForProject(root)).toEqual(new Set(['a'.repeat(64), current]))
  })

  it('does not let a copied bootstrap authorization create an actor outside its authorized actor set', () => {
    const root = fixture()
    const first = JSON.parse(readFileSync(join(root, '.delivery', 'accountability', 'actors.jsonl'), 'utf8').split('\n')[0]!) as Record<string, unknown>
    appendRegistryEvent(root, { authorization: first.authorization })
    expect(() => readActorRegistry(root)).toThrow('ACCOUNTABILITY_REGISTRY_ACTOR_NOT_AUTHORIZED')
  })

  it('rejects an event type that is invalid for the actor current state', () => {
    const root = fixture()
    const first = JSON.parse(readFileSync(join(root, '.delivery', 'accountability', 'actors.jsonl'), 'utf8').split('\n')[0]!) as Record<string, unknown>
    appendRegistryEvent(root, { eventType: 'alias_added', authorization: first.authorization })
    expect(() => readActorRegistry(root)).toThrow('ACCOUNTABILITY_REGISTRY_TRANSITION_INVALID')
  })
})
