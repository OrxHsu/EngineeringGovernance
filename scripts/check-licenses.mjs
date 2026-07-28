import { access } from 'node:fs/promises'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const repositoryRoot = resolve(new URL('..', import.meta.url).pathname)
const allowedLicenses = new Set(['Apache-2.0', 'BSD-3-Clause', 'ISC', 'MIT'])

await access(resolve(repositoryRoot, 'pnpm-lock.yaml'))
const result = spawnSync('pnpm', ['licenses', 'list', '--json'], {
  cwd: repositoryRoot,
  encoding: 'utf8',
  env: process.env,
})

if (result.status !== 0) {
  process.stderr.write(result.stderr || result.stdout || 'LICENSE_GRAPH_UNAVAILABLE\n')
  process.exit(1)
}

const licenseGraph = JSON.parse(result.stdout)
const disallowed = Object.entries(licenseGraph)
  .filter(([license]) => !allowedLicenses.has(license))
  .flatMap(([license, packages]) => packages.map((entry) => ({
    license,
    name: entry.name,
    versions: entry.versions,
  })))
  .sort((left, right) => `${left.license}:${left.name}`.localeCompare(`${right.license}:${right.name}`))

if (disallowed.length > 0) {
  process.stderr.write(`DISALLOWED_DEPENDENCY_LICENSE\n${JSON.stringify(disallowed, null, 2)}\n`)
  process.exitCode = 1
} else {
  const packageCount = Object.values(licenseGraph)
    .reduce((count, packages) => count + packages.length, 0)
  process.stdout.write(`license-check: ok (${packageCount} packages; ${[...allowedLicenses].sort().join(', ')})\n`)
}
