# Changelog

## sop-2.1.0-release-v1

First formal open-source release candidate, prepared on the `2.1.0` package
line. This release includes contract preflight, independent review binding,
append-only evidence and accountability, safe adoption and upgrade planning,
Codex Skill integration, and reproducible Node 22 runner bundles.

The repository is being pushed to a private remote for final owner review.
Public visibility, tag publication, and package publication remain separate
explicit actions.

The local 2.1.0 runner now also supports policy-bound, byte-exact inspection of
beta0-beta3 schema-v2 history and validates contract-readiness ledger evidence
as an append-only whole-event prefix. These behaviors do not rewrite or advance
historical tasks and require a separately reviewed consumer manifest.
Canonical readiness reviews can retain exact governance-authority evidence
across that upgrade only through a policy-bound, byte-preserving historical
evidence manifest.
