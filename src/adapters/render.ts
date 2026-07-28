import { readFileSync } from 'node:fs'

export const MANAGED_BLOCK_START = '<!-- engineering-governance:start -->'
export const MANAGED_BLOCK_END = '<!-- engineering-governance:end -->'

export interface CoreBlockIdentity {
  version: string
  digest: string
}

const template = readFileSync(new URL('../../adapters/core-block.md', import.meta.url), 'utf8')

export function renderCoreBlock(identity: CoreBlockIdentity, command = 'sop'): string {
  if (identity.version.trim().length === 0) throw new Error('GOVERNANCE_VERSION_MISSING')
  if (!/^[a-f0-9]{64}$/u.test(identity.digest)) throw new Error('GOVERNANCE_DIGEST_INVALID')
  if (command.trim().length === 0) throw new Error('SOP_COMMAND_MISSING')

  const rendered = template
    .replaceAll('{{SOP_VERSION}}', identity.version)
    .replaceAll('{{SOP_DIGEST}}', identity.digest)
    .replaceAll('{{SOP_COMMAND}}', command)
  if (rendered.includes('{{')) throw new Error('ADAPTER_TEMPLATE_TOKEN_UNRESOLVED')
  return rendered.endsWith('\n') ? rendered : `${rendered}\n`
}
