import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  applyGlobalInstall,
  checkGlobalInstall,
  planGlobalInstall,
  summarizeGlobalPlan,
} from '../../../../dist/commands/install-global.js'

function digest(path) {
  return existsSync(path)
    ? createHash('sha256').update(readFileSync(path)).digest('hex')
    : null
}

const isolatedHome = mkdtempSync(join(tmpdir(), 'engineering-governance-review-home-'))
const realHome = homedir()
const realManagedPaths = [
  join(realHome, '.codex', 'AGENTS.md'),
  join(realHome, '.codex', 'skills', 'delivery-sop', 'SKILL.md'),
  join(realHome, '.codex', 'skills', 'delivery-sop', 'agents', 'openai.yaml'),
  join(realHome, '.codex', 'skills', 'delivery-sop', '.engineering-governance-skill.json'),
  join(realHome, '.codex', 'bin', 'sop'),
]
const beforeReal = Object.fromEntries(realManagedPaths.map((path) => [path, digest(path)]))

try {
  mkdirSync(join(isolatedHome, '.codex'), { recursive: true })
  const isolatedPlan = planGlobalInstall({ tool: 'codex', homeDirectory: isolatedHome })
  const isolatedSummary = summarizeGlobalPlan(isolatedPlan)
  const applied = applyGlobalInstall(isolatedPlan, isolatedPlan.digest)
  const isolatedCheck = checkGlobalInstall({ tool: 'codex', homeDirectory: isolatedHome })
  if (!isolatedCheck.valid) throw new Error(isolatedCheck.errors.join('\n'))

  const realPlan = planGlobalInstall({ tool: 'codex', homeDirectory: realHome })
  const realSummary = summarizeGlobalPlan(realPlan)
  const afterReal = Object.fromEntries(realManagedPaths.map((path) => [path, digest(path)]))
  if (JSON.stringify(beforeReal) !== JSON.stringify(afterReal)) {
    throw new Error('REAL_HOME_CHANGED_DURING_DRY_RUN')
  }

  process.stdout.write(`${JSON.stringify({
    isolatedPlanDigest: isolatedPlan.digest,
    isolatedWrites: isolatedSummary.writes,
    isolatedApplied: applied.applied,
    isolatedCheck,
    realPlanDigest: realPlan.digest,
    realWrites: realSummary.writes,
    realHomeUnchanged: true,
  }, null, 2)}\n`)
} finally {
  rmSync(isolatedHome, { recursive: true, force: true })
}
