import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = resolve(new URL('..', import.meta.url).pathname)
const required = [
  ['CORE_INVARIANTS.md', 'contract readiness'],
  ['DEVELOPMENT_SOP.md', 'DEFINED -> IN_PROGRESS'],
  ['DEVELOPMENT_SOP.md', 'self-review'],
  ['DEVELOPMENT_SOP.md', 'contract_violation'],
  ['DEVELOPMENT_SOP.md', 'grandfather'],
  ['DEVELOPMENT_SOP.md', 'severity descending'],
  ['DEVELOPMENT_SOP.md', 'eba8165bd069c0e85e5b08217ea260e7b027e85158404a50644c03b57a909aca'],
  ['DEVELOPMENT_SOP.md', 'TREK'],
  ['README.md', 'contract-review'],
  ['templates/task-contract-review.yaml', 'sop-contract-review-v2'],
]
const errors = []
for (const [file, phrase] of required) {
  const content = await readFile(resolve(root, file), 'utf8')
  if (!content.toLowerCase().includes(phrase.toLowerCase())) errors.push(`${file}:${phrase}`)
}
if (errors.length > 0) {
  process.stderr.write(`GOVERNANCE_DOCS_INVALID\n${errors.join('\n')}\n`)
  process.exit(1)
}
process.stdout.write(`governance-docs: ok (${required.length} assertions)\n`)
