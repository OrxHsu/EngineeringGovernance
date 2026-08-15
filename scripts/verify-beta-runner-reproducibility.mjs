import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { basename, dirname, join, resolve } from 'node:path'

const root = resolve(new URL('..', import.meta.url).pathname)
const outputIndex = process.argv.indexOf('--output')
const versionIndex = process.argv.indexOf('--version')
const output = outputIndex >= 0 ? resolve(process.argv[outputIndex + 1] ?? '') : ''
const version = versionIndex >= 0 ? process.argv[versionIndex + 1] : undefined
if (!output || !version) throw new Error('BETA_REPRO_ARGS_REQUIRED')
const node = process.execPath
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim()
await mkdir(output, { recursive: true })
const candidateCommit = git('rev-parse', 'HEAD')
const candidateTree = git('rev-parse', 'HEAD^{tree}')
const first = await mkdtemp(join(output, '.repro-first-'))
const second = await mkdtemp(join(output, '.repro-second-'))
try {
  const builder = resolve(root, 'scripts/build-runner-bundle.mjs')
  execFileSync(node, [builder, '--output', first, '--version', version], { cwd: root, stdio: 'pipe', env: process.env })
  execFileSync(node, [builder, '--output', second, '--version', version], { cwd: root, stdio: 'pipe', env: process.env })
  const filename = `engineering-governance-${version}.tgz`
  const firstBytes = readFileSync(join(first, filename))
  const secondBytes = readFileSync(join(second, filename))
  const firstHash = hash(firstBytes)
  const secondHash = hash(secondBytes)
  if (firstHash !== secondHash || !firstBytes.equals(secondBytes)) throw new Error('BETA_ARCHIVE_NONDETERMINISTIC')
  const listing = execFileSync('tar', ['-tzf', join(first, filename)], { encoding: 'utf8' }).split(/\r?\n/u).filter(Boolean)
  for (const required of ['package/package.json', 'package/VERSION', 'package/dist/cli/main.js', 'package/schemas/task-contract.schema.json', 'package/templates/task-contract.yaml']) {
    if (!listing.includes(required)) throw new Error(`BETA_ARCHIVE_MISSING:${required}`)
  }
  const packageJson = JSON.parse(execFileSync('tar', ['-xOf', join(first, filename), 'package/package.json'], { encoding: 'utf8' }))
  const versionFile = execFileSync('tar', ['-xOf', join(first, filename), 'package/VERSION'], { encoding: 'utf8' }).trim()
  if (packageJson.version !== version || versionFile !== version) throw new Error('BETA_ARCHIVE_VERSION_MISMATCH')
  await mkdir(output, { recursive: true })
  const archivePath = join(output, filename)
  await writeFile(archivePath, firstBytes)
  const receipt = {
    version,
    archivePath: resolve(archivePath),
    sha256: firstHash,
    firstBuildSha256: firstHash,
    secondBuildSha256: secondHash,
    candidateCommit,
    candidateTree,
    identical: true,
  }
  const receiptPath = resolve(root, 'releases', version, 'archive-verification.json')
  await mkdir(dirname(receiptPath), { recursive: true })
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`)
  process.stdout.write(`${JSON.stringify(receipt)}\n`)
} finally {
  await rm(first, { recursive: true, force: true })
  await rm(second, { recursive: true, force: true })
}
