import { createHash } from 'node:crypto'
import { readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { parse } from 'yaml'

const root = resolve(new URL('..', import.meta.url).pathname)
const arg = (name) => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1] }
const taskId = arg('--task-id')
const baseCommit = arg('--base-commit')
const archiveInput = arg('--archive')
const receiptInput = arg('--archive-receipt')
const priorInput = arg('--prior-finding')
if (!taskId || !baseCommit || !archiveInput || !receiptInput || !priorInput) throw new Error('RELEASE_RECORD_ARGS_REQUIRED')
const sha = (value) => createHash('sha256').update(value).digest('hex')
const canonical = (value) => Array.isArray(value) ? value.map(canonical) : (value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)])) : value)
const digest = (value) => sha(JSON.stringify(canonical(value)))
const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim()
const contractPath = `.delivery/tasks/${taskId}/contract.yaml`
const contractRaw = readFileSync(resolve(root, contractPath))
const contract = parse(contractRaw.toString('utf8'))
const commits = git('rev-list', '--reverse', `${baseCommit}..HEAD`).split(/\r?\n/u).filter(Boolean).map((commit) => ({ commit, tree: git('rev-parse', `${commit}^{tree}`) }))
if (git('merge-base', baseCommit, 'HEAD') !== baseCommit) throw new Error('RELEASE_BASE_NOT_ANCESTOR')
const baseTree = git('rev-parse', `${baseCommit}^{tree}`)
const candidateCommit = git('rev-parse', 'HEAD')
const candidateTree = git('rev-parse', 'HEAD^{tree}')
const archivePath = realpathSync(resolve(archiveInput))
const archiveBytes = readFileSync(archivePath)
const receiptPath = resolve(root, receiptInput)
const receiptRaw = readFileSync(receiptPath)
const receipt = JSON.parse(receiptRaw.toString('utf8'))
if (receipt.archivePath !== archivePath || receipt.sha256 !== sha(archiveBytes) || receipt.firstBuildSha256 !== receipt.sha256 || receipt.secondBuildSha256 !== receipt.sha256 || receipt.candidateCommit !== candidateCommit || receipt.candidateTree !== candidateTree || receipt.version !== '2.1.0' || receipt.identical !== true) throw new Error('RELEASE_ARCHIVE_RECEIPT_MISMATCH')
const priorPath = resolve(root, priorInput)
const priorRaw = readFileSync(priorPath)
const record = {
  schemaVersion: 1,
  artifactType: 'engineering-governance-release-record-v1',
  taskId,
  contract: { path: contractPath, rawSha256: sha(contractRaw), digest: contract.contractDigest },
  sourceRange: { baseCommit, baseTree, commits, candidateCommit, candidateTree },
  archive: { filename: `engineering-governance-${receipt.version}.tgz`, path: archivePath, sha256: sha(archiveBytes), version: receipt.version, verificationReceipt: { path: receiptInput, rawSha256: sha(receiptRaw), digest: digest(receipt), ...receipt } },
  sourceIdentity: { packageVersion: JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version, versionFile: readFileSync(resolve(root, 'VERSION'), 'utf8').trim() },
  publicationStatus: 'local-unpublished',
  priorFinding: { path: priorInput, rawSha256: sha(priorRaw), digest: digest(parse(priorRaw.toString('utf8'))) },
}
process.stdout.write(`${JSON.stringify(record, null, 2)}\n`)
