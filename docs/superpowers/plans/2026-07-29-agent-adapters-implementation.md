# Agent Adapters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add drift-detectable adapters for Codex, Qoder, Cursor, Claude, generic AGENTS consumers, and a Codex delivery-sop Skill without duplicating policy authority.

**Architecture:** Adapter templates contain a short generated core block with governance version/digest and route agents to the canonical CLI/policy. The CLI discovers each tool's owning source, emits dry-run patches, preserves unrelated instructions, and verifies generated blocks. The Skill is an operational wrapper around `sop`, not a copy of workflow rules.

**Tech Stack:** TypeScript, Node.js 22, Vitest golden tests, Markdown/YAML adapters, Codex Skill format

---

## File map

- `adapters/core-block.md`: canonical generated agent block.
- `adapters/codex/*`, `adapters/qoder/*`, `adapters/cursor/*`, `adapters/claude/*`: tool-specific source templates.
- `src/adapters/*.ts`: discovery, rendering, installation, and drift verification.
- `skills/delivery-sop/SKILL.md`: source of the installed Codex Skill.
- `src/adapters/ci.ts`, `templates/ci/check-delivery-policy.sh`: portable,
  checksum-pinned project gate and runner bundle integration.
- `tests/golden/adapters/*`, `tests/unit/adapters.test.ts`, `tests/integration/codex-install.test.ts`: golden and installation tests.

### Task 1: Generic managed core block

**Files:**
- Create: `adapters/core-block.md`
- Create: `src/adapters/render.ts`
- Create: `tests/golden/adapters/generic-agents.md`
- Test: `tests/unit/adapters.test.ts`

- [ ] **Step 1: Write the failing golden test**

```ts
import { expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { renderCoreBlock } from '../../src/adapters/render.js'

it('renders the reviewed generic AGENTS block', async () => {
  const golden = await readFile('tests/golden/adapters/generic-agents.md', 'utf8')
  expect(await renderCoreBlock({ version: '1.0.0', digest: 'a'.repeat(64) })).toBe(golden)
})
```

- [ ] **Step 2: Run and observe failure**

Run: `pnpm exec vitest run tests/unit/adapters.test.ts`

Expected: FAIL because renderer and golden are absent.

- [ ] **Step 3: Implement deterministic rendering**

The block names the global policy, non-waivable single-owner/truthful-evidence
rules, risk classification command, project extension boundary, and canonical
version/digest. It contains managed start/end markers and ends with one newline.

- [ ] **Step 4: Verify and commit**

Run: `pnpm exec vitest run tests/unit/adapters.test.ts && pnpm typecheck`

```bash
git add adapters/core-block.md src/adapters/render.ts tests/golden/adapters/generic-agents.md tests/unit/adapters.test.ts
git commit -m "feat: render universal agent governance block"
```

### Task 2: Codex global adapter

**Files:**
- Create: `src/adapters/codex.ts`
- Create: `adapters/codex/global-agents.md`
- Test: `tests/integration/codex-install.test.ts`

- [ ] **Step 1: Write failing ownership and preservation tests**

Use temporary homes containing an existing `.codex/AGENTS.md`. Assert install
adds one managed block, preserves the rest byte-for-byte, a second install is
idempotent, drift fails, and removal refuses an unknown digest.

- [ ] **Step 2: Run the focused test**

Run: `pnpm exec vitest run tests/integration/codex-install.test.ts`

Expected: FAIL because the Codex adapter is missing.

- [ ] **Step 3: Implement persistent-owner discovery**

Check whether a manager owns the global instructions before editing. CC Switch
database inspection is read-only and limited to setting names/ownership; do not
print configuration values or secrets. When no manager owns AGENTS content,
target `~/.codex/AGENTS.md` through the managed-block engine.

- [ ] **Step 4: Verify and commit**

Run: `pnpm exec vitest run tests/integration/codex-install.test.ts && pnpm typecheck`

```bash
git add src/adapters/codex.ts adapters/codex/global-agents.md tests/integration/codex-install.test.ts
git commit -m "feat: add safe Codex global adapter"
```

### Task 3: Qoder, Cursor, Claude, and generic project adapters

**Files:**
- Create: `src/adapters/qoder.ts`
- Create: `src/adapters/cursor.ts`
- Create: `src/adapters/claude.ts`
- Create: `src/adapters/generic.ts`
- Create: `adapters/qoder/agents.md`
- Create: `adapters/cursor/rule.mdc`
- Create: `adapters/claude/import.md`
- Create: `tests/golden/adapters/qoder-agents.md`
- Create: `tests/golden/adapters/cursor-rule.mdc`
- Create: `tests/golden/adapters/claude-import.md`
- Test: `tests/unit/tool-adapters.test.ts`

- [ ] **Step 1: Write failing golden and prohibition tests**

Assert Qoder selects project AGENTS and never creates `.qoder/rules` when AGENTS
is authoritative; Cursor compatibility output is generated only when configured;
Claude imports adjacent AGENTS; generic projects create AGENTS only when absent.

- [ ] **Step 2: Run the focused test**

Run: `pnpm exec vitest run tests/unit/tool-adapters.test.ts`

Expected: FAIL because adapters are absent.

- [ ] **Step 3: Implement exact adapter decisions**

Each adapter returns `owningSource`, `generatedTargets`, `plannedWrites`,
`verification`, and `removal`. It may not insert policy prose outside the shared
rendered block.

- [ ] **Step 4: Verify and commit**

Run: `pnpm exec vitest run tests/unit/tool-adapters.test.ts && pnpm typecheck`

```bash
git add src/adapters adapters/qoder adapters/cursor adapters/claude tests/golden/adapters tests/unit/tool-adapters.test.ts
git commit -m "feat: add cross-tool governance adapters"
```

### Task 4: delivery-sop Skill source and validation

**Files:**
- Create: `skills/delivery-sop/SKILL.md`
- Create: `skills/delivery-sop/agents/openai.yaml`
- Create: `src/adapters/skill.ts`
- Test: `tests/unit/skill-adapter.test.ts`

- [ ] **Step 1: Write a failing Skill-content test**

```ts
import { expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'

it('keeps the Skill operational and policy-free', async () => {
  const text = await readFile('skills/delivery-sop/SKILL.md', 'utf8')
  expect(text).toContain('sop check')
  expect(text).toContain('Read .delivery/policy.yaml')
  expect(text).not.toContain('Only services call transactions')
})
```

- [ ] **Step 2: Run and observe failure**

Run: `pnpm exec vitest run tests/unit/skill-adapter.test.ts`

Expected: FAIL because the Skill source is absent.

- [ ] **Step 3: Create the Skill through the applicable skill-creator workflow**

The Skill triggers on starting, implementing, reviewing, repairing, or closing a
development task. It reads project policy, calls the CLI, reports the derived
risk/state, and stops on missing policy or blocked authorization. It does not
embed the SOP, spawn agents, or mutate production/external systems.

- [ ] **Step 4: Implement checksum-safe Skill installation**

Install to `/Users/xgh/.codex/skills/delivery-sop` only after a dry-run. Preserve
an unrelated existing directory; upgrade only a matching managed installation.

- [ ] **Step 5: Validate and commit**

Run: `pnpm exec vitest run tests/unit/skill-adapter.test.ts && pnpm check`

```bash
git add skills/delivery-sop src/adapters/skill.ts tests/unit/skill-adapter.test.ts
git commit -m "feat: add delivery SOP operational Skill"
```

### Task 5: Adapter CLI integration and global dry-run

**Files:**
- Create: `src/commands/install-global.ts`
- Modify: `src/cli/main.ts`
- Test: `tests/integration/global-adapters.test.ts`
- Modify: `README.md`

- [ ] **Step 1: Write a failing global installation workflow test**

Assert `sop global install --tool codex` defaults to dry-run, prints exact paths
and digests, and `--apply` writes only after the same plan digest is supplied.

- [ ] **Step 2: Run focused test**

Run: `pnpm exec vitest run tests/integration/global-adapters.test.ts`

Expected: FAIL because global commands are absent.

- [ ] **Step 3: Register global commands with plan-digest confirmation**

```ts
program.command('global')
  .command('install')
  .requiredOption('--tool <tool>')
  .option('--apply-plan <digest>')
  .action(runGlobalInstall)
```

- [ ] **Step 4: Run full adapter checks and a real read-only dry-run**

Run: `pnpm check && pnpm sop -- global install --tool codex`

Expected: tests pass; dry-run names the intended Codex AGENTS and Skill paths and
makes no filesystem changes.

- [ ] **Step 5: Commit**

```bash
git add src/commands/install-global.ts src/cli/main.ts tests/integration/global-adapters.test.ts README.md
git commit -m "feat: integrate global agent adapters"
```

### Task 6: Portable project gate bundle

**Files:**
- Create: `src/adapters/ci.ts`
- Create: `templates/ci/check-delivery-policy.sh`
- Create: `scripts/build-runner-bundle.mjs`
- Test: `tests/integration/portable-gate.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Write a failing offline temporary-project test**

Build a package tarball, copy it into a temporary project's
`.delivery/runtime/`, disable network access for the child process, and assert
the wrapper runs the exact pinned CLI. Mutate the tarball and assert a stable
`RUNNER_DIGEST_MISMATCH` failure before execution.

- [ ] **Step 2: Run the focused test**

Run: `pnpm exec vitest run tests/integration/portable-gate.test.ts`

Expected: FAIL because the bundle builder and wrapper do not exist.

- [ ] **Step 3: Implement the checksum-pinned bundle**

`build-runner-bundle.mjs` runs the package build/pack process and returns the
archive path, version, and SHA-256. The project adapter installs the archive as
`.delivery/runtime/engineering-governance-<version>.tgz` and records its digest
in `policy.yaml`.

- [ ] **Step 4: Implement the project wrapper**

The POSIX wrapper resolves its own project root, verifies the archive SHA-256,
creates a temporary npm prefix, installs only the local archive with network
disabled, runs `sop check`, and removes the temporary directory on exit. It must
not write into the project or user-global package configuration.

- [ ] **Step 5: Verify and commit**

Run: `pnpm exec vitest run tests/integration/portable-gate.test.ts && pnpm check`

```bash
git add src/adapters/ci.ts templates/ci/check-delivery-policy.sh scripts/build-runner-bundle.mjs tests/integration/portable-gate.test.ts package.json
git commit -m "feat: add portable project policy gate"
```
