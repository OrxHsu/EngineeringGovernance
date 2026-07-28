# Global Development Risk Classification

Status: canonical development policy

Version: 0.1.0-dev

Select the highest matching risk. Incomplete classification raises a mutating
task to at least R2. Project extensions may raise but not silently lower risk.

## R0 — read-only or advisory

No repository or external state changes. Examples include explanation,
read-only investigation, diagnosis, and audit.

Required result: distinguish confirmed facts, inference, and unknowns. Create a
durable audit only when requested or required by project policy.

## R1 — local and reversible

All of the following must be true:

- change scope is bounded and locally reversible;
- no authentication, authorization, privacy, security, payment, migration,
  production, or destructive boundary is affected;
- no persistent-data contract or cross-module user workflow changes;
- regression impact is small and relevant automated verification is available.

Required result: one owner, scoped diff, fresh verification, remaining-risk
statement, and commit identity when committed. Independent review is optional.

## R2 — important or cross-boundary

Any of the following selects at least R2:

- user-visible feature or behavior change;
- cross-module, multi-repository, or phase/stage work;
- persistence logic or broad regression surface;
- incomplete classification for a mutating task;
- a project rule explicitly selects R2.

Required result: frozen task contract, structured evidence manifest, and an
independent review of the exact candidate.

## R3 — high risk

Any of the following selects R3:

- authentication, authorization, privacy, or security boundary;
- schema/data migration, deletion, recovery, or irreversible mutation;
- payment, billing, production release, deployment, or remote mutation;
- external communication or legal/licensing boundary with material impact;
- restricted runtime/device action or another explicit authorization gate.

Required result: R2 artifacts plus applicable trust/threat analysis,
migration/recovery/rollback plan, specialized gates, scoped authorization, and
production observation plan. Independent review is mandatory.

## Classification rules

1. Record the matched risk triggers; do not record only the final level.
2. Select the highest trigger across every affected repository and system.
3. Do not downgrade risk because a change is short or an agent is confident.
4. A project-specific equivalent control may replace a default mechanism only
   when it satisfies the same invariant and is recorded in project policy.
5. A waiverable downgrade requires a valid exception with reason, scope,
   compensating controls, approver, and expiry.
