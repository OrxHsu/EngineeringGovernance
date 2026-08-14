# Migrating Engineering Governance 1.x to 2.0

Version 2.0.0 is a breaking lifecycle and artifact-format release. An adopted
1.x project remains governed by its pinned 1.x runner until the project owner
reviews and applies an explicit 2.0 upgrade plan. Installing the 2.0 package by
itself does not migrate a project.

## What breaks

- Active mutating tasks use schema-v2 contracts and an append-only
  `ledger.jsonl`; caller-authored state fields are no longer active state.
- Candidate, verification, review, and closure artifacts have one canonical
  filename and bind exact ancestor bytes. Orphans, duplicates, cross-task
  references, stale closures, and ledger disagreement fail project check.
- Review and close are non-executing checks. A legal state transition is applied
  only with the exact plan digest returned for the current artifact and ledger.
- Project extension manifests use schema version 2 and bind each enabled
  extension by ID, version, and digest.
- A v1 task directory is reported as legacy inspect-only. The 2.0 runner does
  not silently advance, accept, repair, or close it.

## Project upgrade

1. Finish or explicitly stop every active 1.x implementation and review. Do not
   rewrite historical task directories to make them look like v2 artifacts.
2. Build or obtain the reviewed `engineering-governance-2.0.0.tgz` runner.
3. Run the 2.0 `upgrade` command without `--apply-plan` and inspect every target,
   before digest, after digest, adapter change, extension change, and runner
   identity.
4. Apply only that unchanged plan with its exact digest. If any managed file
   changed after planning, discard the plan and generate a new dry run.
5. Run the installed `.delivery/bin/check-delivery-policy.sh` and confirm that
   policy, adapter, extension, runner, and task-graph checks pass.

An empty schema-v1 extension manifest can be upgraded to the schema-v2 empty
manifest by the reviewed project upgrade. A non-empty schema-v1 manifest needs
an explicit extension-by-extension migration and must not be silently rewritten.

## Task migration

Do not edit a v1 contract, candidate, review, closure, or evidence file in place.
Choose one of these paths:

- Preserve a completed or abandoned v1 directory as legacy inspect-only
  history.
- Finish an active v1 task with its still-pinned 1.x runner before upgrading the
  project.
- Create a new schema-v2 task with a new task ID and record the legacy task as
  its authority or superseded predecessor.

A new v2 task starts from a schema-v2 input. Persist the returned
`.delivery/tasks/<task-id>/contract.yaml` and `ledger.jsonl` exactly, then use
the canonical `candidate.yaml`, `verification.json`, `review.yaml`, and
`closure.yaml` paths. Do not copy an accepted v1 decision into the v2 ledger.

## Verification

Run under Node.js 22 with the committed lockfile:

```sh
pnpm typecheck
pnpm test
pnpm build
pnpm check:placeholders
pnpm check:licenses
```

Historical plans, handoffs, adoption records, and evidence remain historical
records. Their recorded 1.x version text is not release metadata and must not be
rewritten during this migration.

If the project owner chooses not to use Engineering Governance, do not perform
an upgrade. Run `sop unadopt <project>` to inspect the exact removal plan and
apply only its unchanged digest. This removes managed policy/adapter/runner
material while preserving task/evidence history, Git history, and unrelated
project files.
