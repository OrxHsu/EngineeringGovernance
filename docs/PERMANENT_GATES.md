# Permanent Gates

Permanent gates are actor-specific controls installed after a verified
remediation. They prevent the same normalized defect class from passing the
same lifecycle boundary again.

The authoritative document is
`.delivery/accountability/permanent-gates/<actor-id>.json`. It binds the actor,
defect class, rule, installation time, originating finding, and remediation
event digest. The document has a canonical digest. Trigger records are ordered
and digest-chained, so deletion, reordering, or field changes fail closed.

Gate types:

- `preflight-check`: blocks task preflight when its rule fails.
- `review-required`: requires an enhanced independent-review control; it is not
  treated as a preflight rule.
- `post-implementation`: reserved for checks evaluated against a candidate.

Built-in preflight mappings include source/test pairing, authority
completeness, scope/acceptance coverage, and mandatory R3 security coverage.
Unknown preflight rules are errors rather than no-ops.

View an actor's exact document with:

```sh
pnpm sop -- accountability gates --project /absolute/path/to/project --actor <actor-id>
```

The view command is read-only. Gate installation and trigger recording are
explicit mutations and must follow verified remediation and the project's
authorization path. A preflight check never writes trigger history as a side
effect.
