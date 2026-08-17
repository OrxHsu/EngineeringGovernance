import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { stringify } from 'yaml'
import { afterEach, describe, expect, it } from 'vitest'

import {
  applyAccountabilityBootstrap,
  planAccountabilityBootstrap,
} from '../../src/commands/accountability-bootstrap.js'
import { readActorRegistry } from '../../src/accountability/registry.js'
import { resolveRegisteredActor } from '../../src/accountability/registry.js'

const projectRoot = process.cwd()
const temporary: string[] = []

function fixture(): { root: string; input: string } {
  const root = mkdtempSync(join(tmpdir(), 'initial-actor-bootstrap-'))
  temporary.push(root)
  mkdirSync(join(root, '.delivery'), { recursive: true })
  copyFileSync(join(projectRoot, '.delivery', 'policy.yaml'), join(root, '.delivery', 'policy.yaml'))
  const policy = readFileSync(join(root, '.delivery', 'policy.yaml'), 'utf8').match(/^sopDigest: (.+)$/m)?.[1]
  if (policy === undefined) throw new Error('test policy digest missing')
  const input = join(root, '.delivery', 'input.yaml')
  writeFileSync(input, stringify({
    schemaVersion: 1,
    artifactType: 'engineering-governance-initial-actor-bootstrap-v1',
    bootstrapId: 'test-initial-bootstrap',
    authorizationId: 'test-initial-bootstrap-authorization',
    projectRoot: root,
    policyDigest: policy,
    grantor: { id: 'user-authority', role: 'user', trustLevel: 'local-claim' },
    issuedAt: '2026-08-16T13:00:00.000Z',
    expiresAt: '2027-08-16T13:00:00.000Z',
    status: 'approved',
    actors: [
      { actorId: 'codex', aliases: ['codex-agent'], role: 'contract-author' },
      { actorId: 'cursor', aliases: ['cursor-agent'], role: 'implementation-owner' },
      { actorId: 'independent-contract-reviewer', aliases: ['independent-reviewer'], role: 'contract-reviewer' },
      { actorId: 'independent-implementation-reviewer', aliases: ['implementation-reviewer'], role: 'implementation-reviewer' },
      { actorId: 'qoder', aliases: ['qoder-agent'], role: 'implementation-owner' },
      { actorId: 'user-authority', aliases: ['user'], role: 'supervisor' },
    ],
  }, { lineWidth: 0 }))
  return { root, input }
}

afterEach(() => {
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('initial actor bootstrap', () => {
  it('writes a complete first registry and registers either implementation owner', () => {
    const { root, input } = fixture()
    const plan = planAccountabilityBootstrap(root, input)
    const result = applyAccountabilityBootstrap(plan, plan.digest) as { actors: Array<{ actorId: string; role: string }> }
    expect(result.actors).toEqual(expect.arrayContaining([
      { actorId: 'qoder', role: 'implementation-owner', trustLevel: 'local-claim', aliases: ['qoder-agent'], active: true, sequence: 5, eventDigest: expect.any(String) },
      { actorId: 'cursor', role: 'implementation-owner', trustLevel: 'local-claim', aliases: ['cursor-agent'], active: true, sequence: 2, eventDigest: expect.any(String) },
    ]))
    expect(resolveRegisteredActor(root, 'independent-reviewer').actorId).toBe('independent-contract-reviewer')
    expect(readActorRegistry(root).events).toHaveLength(6)
    expect(() => planAccountabilityBootstrap(root, input)).toThrow('ACCOUNTABILITY_INITIAL_BOOTSTRAP_ALREADY_EXISTS')
  })

  it('rejects a changed policy between preview and apply', () => {
    const { root, input } = fixture()
    const plan = planAccountabilityBootstrap(root, input)
    const policyPath = join(root, '.delivery', 'policy.yaml')
    writeFileSync(policyPath, `${readFileSync(policyPath, 'utf8')}\n`)
    expect(() => applyAccountabilityBootstrap(plan, plan.digest)).toThrow('MANAGED_FILE_CHANGED:')
  })
})
