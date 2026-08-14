import { readdir, readFile, stat } from 'node:fs/promises'
import { extname, join, relative, resolve } from 'node:path'

const repositoryRoot = resolve(new URL('..', import.meta.url).pathname)
const rootFiles = [
  'CORE_INVARIANTS.md',
  'DEVELOPMENT_SOP.md',
  'MIGRATING_TO_2.0.md',
  'README.md',
  'RISK_CLASSIFICATION.md',
  'VERSION',
]
const sourceDirectories = [
  'adapters',
  'portable',
  'schemas',
  'scripts',
  'skills',
  'src',
  'templates',
  'tests',
]
const scannedExtensions = new Set(['.json', '.js', '.md', '.mjs', '.sh', '.ts', '.yaml', '.yml'])
const markerWords = [
  ['TO', 'DO'].join(''),
  ['T', 'BD'].join(''),
  ['FIX', 'ME'].join(''),
  ['PLACE', 'HOLDER'].join(''),
  ['X', 'XX'].join(''),
]
const markerPattern = new RegExp(`\\b(?:${markerWords.join('|')})\\b`, 'i')

async function existingFiles(path) {
  try {
    const metadata = await stat(path)
    if (metadata.isFile()) return [path]
    if (!metadata.isDirectory()) return []
  } catch (error) {
    if (error && error.code === 'ENOENT') return []
    throw error
  }

  const entries = await readdir(path, { withFileTypes: true })
  const nested = await Promise.all(entries
    .filter((entry) => !entry.name.startsWith('.'))
    .map((entry) => existingFiles(join(path, entry.name))))
  return nested.flat()
}

const paths = [
  ...rootFiles.map((path) => join(repositoryRoot, path)),
  ...sourceDirectories.map((path) => join(repositoryRoot, path)),
]
const files = (await Promise.all(paths.map(existingFiles)))
  .flat()
  .filter((path) => extname(path) === '' || scannedExtensions.has(extname(path)))
  .sort()

const findings = []
for (const path of files) {
  const lines = (await readFile(path, 'utf8')).split(/\r?\n/u)
  lines.forEach((line, index) => {
    if (markerPattern.test(line)) findings.push(`${relative(repositoryRoot, path)}:${index + 1}`)
  })
}

if (findings.length > 0) {
  process.stderr.write(`UNRESOLVED_MARKERS\n${findings.join('\n')}\n`)
  process.exitCode = 1
} else {
  process.stdout.write(`marker-check: ok (${files.length} files)\n`)
}
