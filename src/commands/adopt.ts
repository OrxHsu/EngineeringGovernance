import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { parse, stringify } from 'yaml'

import type { ValidationResult } from '../model/types.js'
import { validateProjectPolicy } from '../policy/load.js'
import { createManagedBlock, planManagedBlockWrite } from '../project/managed-block.js'
import type { PlannedWrite } from '../project/mutate.js'

export interface AdoptionPlan {
  projectRoot: string
  writes: PlannedWrite[]
  digest: string
}

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex')
}

function governanceFile(path: string): string {
  return readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')
}

export function governanceIdentity(): { version: string; digest: string } {
  const version = governanceFile('VERSION').trim()
  const digest = sha256([
    governanceFile('CORE_INVARIANTS.md'),
    governanceFile('DEVELOPMENT_SOP.md'),
    governanceFile('RISK_CLASSIFICATION.md'),
    version,
  ].join('\n--governance-source--\n'))
  return { version, digest }
}

function planTextWrite(path: string, after: string): PlannedWrite {
  const before = existsSync(path) ? readFileSync(path, 'utf8') : undefined
  return {
    path,
    beforeDigest: before === undefined ? null : sha256(before),
    after,
  }
}

function planDigest(projectRoot: string, writes: PlannedWrite[]): string {
  return sha256(JSON.stringify({
    projectRoot,
    writes: writes.map((write) => ({
      path: write.path,
      beforeDigest: write.beforeDigest,
      afterDigest: sha256(write.after),
    })),
  }))
}

export function planAdoption(projectPath: string): AdoptionPlan {
  const projectRoot = resolve(projectPath)
  const identity = governanceIdentity()
  const block = createManagedBlock(identity)
  const blockDigest = sha256(block)
  const policy = {
    schemaVersion: 1,
    sopVersion: identity.version,
    sopDigest: identity.digest,
    projectId: projectRoot.split('/').filter(Boolean).at(-1) ?? 'project',
    adapters: [{
      tool: 'generic-agents',
      source: 'AGENTS.md',
      targets: ['AGENTS.md'],
      digest: blockDigest,
    }],
    artifactMapping: {},
  }
  const writes = [
    planTextWrite(join(projectRoot, '.delivery', 'policy.yaml'), stringify(policy)),
    planTextWrite(
      join(projectRoot, '.delivery', 'extensions.yaml'),
      stringify({ schemaVersion: 1, extensions: [] }),
    ),
    planManagedBlockWrite(join(projectRoot, 'AGENTS.md'), block),
  ]
  return { projectRoot, writes, digest: planDigest(projectRoot, writes) }
}

export function verifyAdoptedProject(projectPath: string): ValidationResult {
  const projectRoot = resolve(projectPath)
  const policyPath = join(projectRoot, '.delivery', 'policy.yaml')
  const agentsPath = join(projectRoot, 'AGENTS.md')
  const errors: string[] = []
  if (!existsSync(policyPath)) return { valid: false, errors: ['PROJECT_POLICY_MISSING'] }

  const policy = parse(readFileSync(policyPath, 'utf8')) as unknown
  const schema = validateProjectPolicy(policy)
  if (!schema.valid) errors.push(...schema.errors.map((error) => `PROJECT_POLICY_INVALID:${error}`))

  const identity = governanceIdentity()
  if (
    typeof policy !== 'object'
    || policy === null
    || (policy as Record<string, unknown>).sopVersion !== identity.version
    || (policy as Record<string, unknown>).sopDigest !== identity.digest
  ) {
    errors.push('PROJECT_POLICY_IDENTITY_MISMATCH')
  }
  if (!existsSync(agentsPath) || !readFileSync(agentsPath, 'utf8').includes(identity.digest)) {
    errors.push('AGENT_ADAPTER_MISSING_OR_DRIFTED')
  }

  const uniqueErrors = [...new Set(errors)].sort()
  return { valid: uniqueErrors.length === 0, errors: uniqueErrors }
}
