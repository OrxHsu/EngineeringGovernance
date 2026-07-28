# ProjTrav V1 Governance Adoption

Status: applied; independent review pending
Date: 2026-07-29

## Candidate

- Governance implementation commit: `5ee1a70bdbd32a5c5e9044c522757801e0d43df1`
- Governance implementation tree: `25ba5efaaecf2a2ebdcd72e776d722035f22dce2`
- SOP version: `1.0.0`
- SOP digest: `ea247f12a2f2cee2bcea67affd0f3e93fc9ee198ddd2036226015f10845ba26e`
- Runner digest: `83aa693997938c9b2f01b12d81ea73af88dd227dd3701743de67052fcc8b985f`

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

- Initial development adoption:
  - Workspace: `a70b6b2c3327fdc47671f4c9d2c31ecbe0d5511b`
  - Server: `ec3d882fb318567ccb207537f0fb1b3db5ed9894`
  - iOS: `c19f9b858bee75e886c9d002a843ed4b5b888870`
- `1.0.0` upgrade:
  - Workspace: `872ddb4e15247a17d3141b455a59aac3ee5e60b8`
  - Server: `47754d1e14b2ea37521db282cc1e0488fe0c7d9c`
  - iOS: `59d9d20de0ca5aea389c3363499e6d3b81c7bb94`
- Trusted-clock runner refresh:
  - Workspace: `63206f629a2e52154a5182efa67380ad9e62e711`
- Artifact-binding and generated-target repair refresh:
  - Workspace: `3ad83efe6ccc3c48a0404033388722d3a64f3de0`
  - Server: `b6c58b35584353fe0b6badd38587ed743f667865`
  - iOS: `ee7ab323d872c9bb39163236fec27282d997f6ad`

Only the planned governance files and generated adapters were staged. The pre-existing handoff and untracked files remain outside these commits.

## Verification

- `scripts/sync-docs.sh --write`: exit 0
- `scripts/sync-docs.sh --check`: exit 0 before and after commits
- `node scripts/generate-physical-catalog.mjs --check`: PASS, 233 tables, digest `69c77bf60898366e6ad4002f6b71ef62aca9ad9bfbc4c762c0946ef90789ce0c`
- `node scripts/check-entity-contract-manifest.mjs --check`: PASS, 326 entities and 233 operations, digest `a9323f876740788f7dbf4e89cf5396810d525385238eae24a5523ba8ae0cf621`
- `.delivery/bin/check-delivery-policy.sh`: `{ "valid": true, "errors": [] }` after the final refresh in all three repositories
- The fresh real-project dry-run recorded all five generated targets in the adoption plan, checked their owning-repository dirty state and before-digests, and observed zero mutation.
- No Simulator, device enumeration, runtime test, database migration, deployment, push, or external operation was performed.

## Remaining gate

An independent reviewer must inspect the exact final commits and trees recorded
in the repair candidate plus fresh machine execution receipts before this R3
adoption can be called independently accepted.
