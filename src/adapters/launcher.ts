import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, readFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { ValidationResult } from '../model/types.js'
import type { PlannedWrite } from '../project/mutate.js'

const launcherMode = 0o755

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex')
}

function packageRoot(): string {
  return resolve(fileURLToPath(new URL('../..', import.meta.url)))
}

export function defaultGovernanceRoot(): string {
  const root = packageRoot()
  const result = spawnSync('git', [
    'rev-parse',
    '--path-format=absolute',
    '--git-common-dir',
  ], { cwd: root, encoding: 'utf8' })
  if (result.status !== 0) return root
  const commonDirectory = resolve(root, result.stdout.trim())
  return basename(commonDirectory) === '.git' ? dirname(commonDirectory) : root
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\"'\"'`)}'`
}

export function renderLauncher(governanceRoot: string): string {
  return `#!/bin/sh
set -eu

if [ -n "\${ENGINEERING_GOVERNANCE_ROOT:-}" ]; then
  sop_governance_root=$ENGINEERING_GOVERNANCE_ROOT
else
  sop_governance_root=${shellQuote(resolve(governanceRoot))}
fi

if [ -d /opt/homebrew/opt/node@22/bin ]; then
  PATH="/opt/homebrew/opt/node@22/bin:$PATH"
  export PATH
fi

if ! command -v pnpm >/dev/null 2>&1; then
  echo "sop: pnpm is unavailable" >&2
  exit 69
fi
if [ ! -f "$sop_governance_root/package.json" ]; then
  echo "sop: governance root is unavailable: $sop_governance_root" >&2
  exit 69
fi

exec pnpm --dir "$sop_governance_root" sop -- "$@"
`
}

export function planLauncherInstall(options: {
  homeDirectory: string
  governanceRoot?: string
}): PlannedWrite[] {
  const path = join(resolve(options.homeDirectory), '.codex', 'bin', 'sop')
  const after = renderLauncher(options.governanceRoot ?? defaultGovernanceRoot())
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
    throw new Error('GLOBAL_LAUNCHER_IS_SYMLINK')
  }
  const before = existsSync(path) ? readFileSync(path, 'utf8') : undefined
  const currentMode = existsSync(path) ? lstatSync(path).mode & 0o777 : undefined
  if (before === after && currentMode === launcherMode) return []
  return [{
    path,
    beforeDigest: before === undefined ? null : sha256(before),
    after,
    mode: launcherMode,
  }]
}

export function verifyLauncherInstall(options: {
  homeDirectory: string
  governanceRoot?: string
}): ValidationResult {
  const path = join(resolve(options.homeDirectory), '.codex', 'bin', 'sop')
  if (!existsSync(path)) return { valid: false, errors: ['GLOBAL_LAUNCHER_MISSING'] }
  const metadata = lstatSync(path)
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    return { valid: false, errors: ['GLOBAL_LAUNCHER_UNSAFE'] }
  }
  const errors: string[] = []
  const expected = renderLauncher(options.governanceRoot ?? defaultGovernanceRoot())
  if (readFileSync(path, 'utf8') !== expected) errors.push('GLOBAL_LAUNCHER_DRIFTED')
  if ((metadata.mode & 0o777) !== launcherMode) errors.push('GLOBAL_LAUNCHER_MODE_DRIFTED')
  return { valid: errors.length === 0, errors }
}
