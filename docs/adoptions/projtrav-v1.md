# ProjTrav V1 Governance Adoption

Status: applied; independent review pending
Date: 2026-07-29

## Candidate

- Governance implementation commit: `da5f19434740defa76c02ea74a3eed6f7d342266`
- SOP version: `0.1.0-dev`
- SOP digest: `e0242ef38e3d6e5c7bd537fa81108e1a20d7eb7417861e2383c3ec442af74c53`
- Runner digest: `b541e925883d8f859bdc59db358ca626f5578b2d327d5e30575478ca49c26d41`
- Reviewed dry-run digest: `e2c77cee8e54b307e18a8956db3e33dafa81aa42b82985ab04d508bbf6860b56`

## Authority map

- Workspace authority: `Docs/AGENTS.md`
- Workspace adapter source: `Docs/rules/workspace-agent-entrypoint.md`
- Server adapter source: `Docs/rules/backend-agent-rules.md`
- iOS adapter source: `Docs/rules/ios-agent-rules.md`
- Generated targets were produced only through `scripts/sync-docs.sh --write`.
- Root `Docs/` remained authoritative; no TREK implementation material was inspected.

## Pre-adoption state

- Workspace: `4833da6922d29fd769db4dad55cd4e9ec0908ab7`
  - existing dirty path: `Docs/handoffs/phase-2b-places-map.md`
- Server: `3f912a672b6d5586c6ac4683ccaeb671dd2aa7c9`
  - existing generated handoff drift and untracked evidence/test copies were preserved and not staged
- iOS: `cb9e4c2e3df5c33cb7bcbc0f9d53b974b4a6921f`
  - existing Qoder/Xcode/TestResults untracked paths were preserved and not staged
- Thread inspection found no competing active Codex writer; the only active ProjTrav task was the current governance task.
- The Qoder desktop process was running, but no managed-path overlap or in-scope build/test process was observed. Exact before-digest checks remained the final write guard.

## Applied commits

- Workspace: `a70b6b2c3327fdc47671f4c9d2c31ecbe0d5511b`
- Server: `ec3d882fb318567ccb207537f0fb1b3db5ed9894`
- iOS: `c19f9b858bee75e886c9d002a843ed4b5b888870`

Only the planned governance files and generated adapters were staged. The pre-existing handoff and untracked files remain outside these commits.

## Verification

- `scripts/sync-docs.sh --write`: exit 0
- `scripts/sync-docs.sh --check`: exit 0 before and after commits
- `node scripts/generate-physical-catalog.mjs --check`: PASS, 233 tables, digest `69c77bf60898366e6ad4002f6b71ef62aca9ad9bfbc4c762c0946ef90789ce0c`
- `node scripts/check-entity-contract-manifest.mjs --check`: PASS, 326 entities and 233 operations, digest `a9323f876740788f7dbf4e89cf5396810d525385238eae24a5523ba8ae0cf621`
- `.delivery/bin/check-delivery-policy.sh`: `{ "valid": true, "errors": [] }` before and after commits
- No Simulator, device enumeration, runtime test, database migration, deployment, push, or external operation was performed.

## Remaining gate

An independent reviewer must inspect the exact three commits and fresh verification before this R3 adoption can be called independently accepted.
