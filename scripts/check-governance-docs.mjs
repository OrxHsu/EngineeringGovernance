import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = resolve(new URL('..', import.meta.url).pathname)
const files = new Map()
async function content(file) {
  if (!files.has(file)) files.set(file, await readFile(resolve(root, file), 'utf8'))
  return files.get(file)
}

const assertions = [
  {
    name: 'core gate is global and non-waivable',
    file: 'CORE_INVARIANTS.md',
    test: (value) => /CORE-CONTRACT-02[\s\S]{0,260}independent local-claim reviewer[\s\S]{0,180}R1 remains owner-only/u.test(value),
  },
  {
    name: 'risk classification requires pre-implementation readiness',
    file: 'RISK_CLASSIFICATION.md',
    test: (value) => /frozen task contract[\s\S]{0,180}contract-readiness review[\s\S]{0,180}before `IN_PROGRESS`/u.test(value),
  },
  {
    name: 'implementation and reviewer roles are separate',
    file: 'DEVELOPMENT_SOP.md',
    test: (value) => /contract author and implementation\s+owner are not the contract-readiness approver[\s\S]{0,500}independent reviewer runs[\s\S]{0,700}Self-review is forbidden/u.test(value),
  },
  {
    name: 'generic checklist and finding order are frozen',
    file: 'DEVELOPMENT_SOP.md',
    test: (value) => /Generic completeness\s+categories are always `PASS`[\s\S]{0,500}Findings are ordered by severity descending/u.test(value),
  },
  {
    name: 'grandfather tuple is explicit',
    file: 'DEVELOPMENT_SOP.md',
    test: (value) => /sopVersion:\s*2\.0\.0[\s\S]{0,180}eba8165bd069c0e85e5b08217ea260e7b027e85158404a50644c03b57a909aca[\s\S]{0,180}sequence-1 `null -> DEFINED`/u.test(value),
  },
  {
    name: 'external-source boundary is default-deny',
    file: 'DEVELOPMENT_SOP.md',
    test: (value) => /External-source use is default-deny[\s\S]{0,300}task remains `independent`/u.test(value),
  },
  {
    name: 'TREK boundary is explicit',
    file: 'DEVELOPMENT_SOP.md',
    test: (value) => /does not grant access to TREK implementation material/u.test(value),
  },
  {
    name: 'CLI exposes contract-review',
    file: 'README.md',
    test: (value) => /task contract-review --input/u.test(value),
  },
  {
    name: 'review template has usable evidence structure',
    file: 'templates/task-contract-review.yaml',
    test: (value) => /reviewId:\s*crv-example-task-[0-9a-f]{64}/u.test(value)
      && !/evidenceRefs:\s*\[\s*\]/u.test(value)
      && /applicabilityReason:\s*no-scoped-authorization-action/u.test(value),
  },
  {
    name: 'task template declares readiness',
    file: 'templates/task-contract.yaml',
    test: (value) => /contractReadiness:[\s\S]{0,140}gateVersion:\s*2\.1\.0-beta\.0/u.test(value),
  },
]

const failures = []
for (const assertion of assertions) {
  const value = await content(assertion.file)
  if (!assertion.test(value)) failures.push(`${assertion.file}:${assertion.name}`)
}
if (failures.length > 0) {
  process.stderr.write(`GOVERNANCE_DOCS_INVALID\n${failures.join('\n')}\n`)
  process.exit(1)
}
process.stdout.write(`governance-docs: ok (${assertions.length} semantic assertions)\n`)
