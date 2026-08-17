# Contributing

Thank you for improving Engineering Governance. Contributions should make the
workflow more reliable, more inspectable, or easier to adopt.

## Development

Use Node.js 22 and pnpm:

```sh
pnpm install --frozen-lockfile
pnpm check
```

Keep changes focused. Source changes belong in `src/`; schemas and templates
are canonical inputs; generated `dist/` must be regenerated with `pnpm build`.
Add or update focused unit/integration/adversarial tests for behavior changes.

## Pull Requests

Explain the user-visible or workflow-visible behavior, the evidence used to
verify it, and any compatibility or migration impact. Do not include secrets,
private attachments, local absolute paths, generated runtime state, or copied
vendor material. Historical `.delivery` evidence is retained only when it is
needed to verify the repository's own task graph.

Before opening a pull request, run `pnpm check` and `git diff --check` and
report any intentionally skipped test with its reason.

By contributing, you agree that your contribution is provided under the
Apache-2.0 License.
