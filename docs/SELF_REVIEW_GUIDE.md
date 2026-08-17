# Contract Author Self-Review

Self-review is a short advisory pass before contract preflight. It catches
obvious omissions and gives the independent reviewer a visible author position.
It never accepts the contract or authorizes implementation.

## Prepare

Run the command against a complete beta1-style task input that does not yet
contain `selfReview` or `knownIssues`:

```sh
pnpm sop -- contract self-check --input /absolute/path/to/start.yaml
```

The JSON request binds the input raw SHA-256 and canonical subject digest. Give
its prompt to the contract authoring AI at medium effort. Stop after 300 seconds.

## Finalize

Place the structured answer in a YAML or JSON response with exactly these
fields: `durationSeconds`, `dimensions`, `overallStatus`, and `knownIssues`.
Then run:

```sh
pnpm sop -- contract self-check \
  --input /absolute/path/to/start.yaml \
  --response /absolute/path/to/self-review-response.yaml
```

Use the returned `augmentedInput` for preflight. Do not edit the generated
`reviewId`, author, task, subject digest, effort, or attempt count.

The six dimensions must remain in canonical order. A normal concern must have a
matching LOW or MEDIUM known issue. A blocker is repaired before submission; it
cannot be hidden in `knownIssues`. Timeout results still contain all six
dimensions and use `TIMEOUT_SUBMITTED` with exactly 300 seconds.

The one-pass property is enforced on an attached input. Because this packet is
an unauthenticated local claim, deleting history could evade it; independent
review remains mandatory and treats the self-review only as advisory evidence.
