import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'

import type { PlannedWrite } from './mutate.js'

export const MANAGED_BLOCK_START = '<!-- engineering-governance:start -->'
export const MANAGED_BLOCK_END = '<!-- engineering-governance:end -->'

export interface ManagedBlockIdentity {
  version: string
  digest: string
}

function digest(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

export function createManagedBlock(identity: ManagedBlockIdentity): string {
  return [
    MANAGED_BLOCK_START,
    '## Global Development Workflow',
    '',
    `Governance version: \`${identity.version}\``,
    `Governance digest: \`${identity.digest}\``,
    '',
    'Before mutating work, load the adopted project policy, classify risk, and keep one implementation owner.',
    'Completion claims require fresh evidence; R2/R3 require independent review of the exact candidate.',
    MANAGED_BLOCK_END,
  ].join('\n')
}

function upsert(existing: string, block: string): string {
  const start = existing.indexOf(MANAGED_BLOCK_START)
  const end = existing.indexOf(MANAGED_BLOCK_END)
  if ((start >= 0) !== (end >= 0) || (start >= 0 && end < start)) {
    throw new Error('MANAGED_BLOCK_MALFORMED')
  }

  if (start >= 0) {
    const suffixStart = end + MANAGED_BLOCK_END.length
    return `${existing.slice(0, start)}${block}${existing.slice(suffixStart)}`
  }
  if (existing.length === 0) return `${block}\n`
  return `${block}\n\n${existing}`
}

export function planManagedBlockWrite(path: string, block: string): PlannedWrite {
  const exists = existsSync(path)
  const before = exists ? readFileSync(path, 'utf8') : ''
  return {
    path,
    beforeDigest: exists ? digest(before) : null,
    after: upsert(before, block),
  }
}
