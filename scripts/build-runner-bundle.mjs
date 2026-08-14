import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const repositoryRoot = resolve(new URL('..', import.meta.url).pathname)
const outputIndex = process.argv.indexOf('--output')
if (outputIndex < 0 || !process.argv[outputIndex + 1]) {
  process.stderr.write('BUNDLE_OUTPUT_REQUIRED\n')
  process.exit(2)
}
const outputDirectory = resolve(process.argv[outputIndex + 1])
const versionIndex = process.argv.indexOf('--version')
const versionOverride = versionIndex >= 0 ? process.argv[versionIndex + 1] : undefined
if (versionOverride !== undefined && !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(versionOverride)) {
  process.stderr.write('BUNDLE_VERSION_INVALID\n')
  process.exit(2)
}
await mkdir(outputDirectory, { recursive: true })

function run(command, arguments_) {
  const result = spawnSync(command, arguments_, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: process.env,
  })
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout || `BUNDLE_COMMAND_FAILED:${command}\n`)
    process.exit(result.status ?? 1)
  }
  return result.stdout
}

async function copyPackageClosure(sourcePackage, targetPackage, ancestry = new Set()) {
  const source = await realpath(sourcePackage)
  const metadata = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'))
  await cp(source, targetPackage, { recursive: true, dereference: true })
  const nextAncestry = new Set(ancestry).add(metadata.name)
  for (const dependency of Object.keys(metadata.dependencies ?? {}).sort()) {
    if (nextAncestry.has(dependency)) continue
    await copyPackageClosure(
      join(dirname(source), dependency),
      join(targetPackage, 'node_modules', dependency),
      nextAncestry,
    )
  }
}

const stage = await mkdtemp(join(outputDirectory, '.runner-stage-'))
try {
  run('pnpm', ['exec', 'tsc', '-p', 'tsconfig.json', '--outDir', resolve(stage, 'dist')])
  const packagePaths = [
    'package.json',
    'CORE_INVARIANTS.md',
    'DEVELOPMENT_SOP.md',
    'MIGRATING_TO_2.0.md',
    'RISK_CLASSIFICATION.md',
    'VERSION',
    'adapters',
    'schemas',
    'scripts',
    'skills/delivery-sop',
    'src',
    'templates',
  ]
  for (const relativePath of packagePaths) {
    await cp(resolve(repositoryRoot, relativePath), resolve(stage, relativePath), {
      recursive: true,
      dereference: true,
    })
  }
  if (versionOverride !== undefined) {
    const packagePath = resolve(stage, 'package.json')
    const packageJson = JSON.parse(await readFile(packagePath, 'utf8'))
    packageJson.version = versionOverride
    await writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`)
    await writeFile(resolve(stage, 'VERSION'), `${versionOverride}\n`)
  }
  for (const dependency of ['ajv', 'commander', 'yaml']) {
    await copyPackageClosure(
      resolve(repositoryRoot, 'node_modules', dependency),
      resolve(stage, 'node_modules', dependency),
    )
  }

  const packResult = spawnSync('npm', ['pack', '--pack-destination', outputDirectory], {
    cwd: stage,
    encoding: 'utf8',
    env: process.env,
  })
  if (packResult.status !== 0) {
    process.stderr.write(packResult.stderr || packResult.stdout || 'BUNDLE_PACK_FAILED\n')
    process.exit(packResult.status ?? 1)
  }
  const packedLine = packResult.stdout
    .split(/\r?\n/u)
    .findLast((line) => line.trim().endsWith('.tgz'))
  if (!packedLine) {
    process.stderr.write('BUNDLE_ARCHIVE_NOT_REPORTED\n')
    process.exit(1)
  }

  const reportedPath = packedLine.trim()
  const packedPath = resolve(outputDirectory, basename(reportedPath))
  const version = versionOverride ?? (await readFile(resolve(repositoryRoot, 'VERSION'), 'utf8')).trim()
  const archivePath = resolve(outputDirectory, `engineering-governance-${version}.tgz`)
  if (packedPath !== archivePath) await rename(packedPath, archivePath)
  const sha256 = createHash('sha256').update(await readFile(archivePath)).digest('hex')
  process.stdout.write(`${JSON.stringify({ archivePath, version, sha256 })}\n`)
} finally {
  await rm(stage, { recursive: true, force: true })
}
