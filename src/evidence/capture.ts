import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

import { parse } from 'yaml'

import { governanceIdentity } from '../commands/adopt.js'
import { implementationOwnersOf } from '../model/ownership.js'
import { canonicalDigest } from '../model/digest.js'
import { validateDocument } from '../policy/load.js'
import { validateHardenedTaskContract } from '../policy/task-contract.js'
import { canonicalTaskPath, readTaskLedger } from '../state/ledger.js'
import { captureRepositorySet, type CheckoutSnapshot } from './checkout-snapshot.js'

export interface ExactCommand {
  executable: string
  arguments: string[]
  cwd: string
}

export interface FrozenCommand extends ExactCommand {
  executableSha256: string
  environment: Record<string, string>
}

export interface LegacyCommandExecutionInput {
  schemaVersion: 1
  runId: string
  command: ExactCommand
  outputPath: string
}

export interface HardenedCommandExecutionInput {
  schemaVersion: 2
  projectRoot: string
  taskId: string
  acceptanceId: string
  runId: string
}

export type CommandExecutionInput = LegacyCommandExecutionInput | HardenedCommandExecutionInput

export interface LegacyCommandExecutionArtifact {
  schemaVersion: 1
  artifactType: 'sop-command-execution-v1'
  producer: { name: '@xgh/engineering-governance'; version: string }
  runId: string
  command: ExactCommand
  startedAt: string
  endedAt: string
  exitCode: number
  environment: { node: string; platform: NodeJS.Platform; arch: string }
  checks: Array<{ id: string; status: 'passed' | 'failed' }>
  stdout: string
  stderr: string
}

interface HardenedContract {
  schemaVersion: 2
  taskId: string
  policyDigest: string
  sopVersion: string
  contractDigest: string
  implementationOwner?: string
  implementationOwners?: string[]
  repositories: Array<{ id: string; path: string }>
  acceptance: Array<{
    id: string
    evidenceKind: string
    command: {
      repositoryId: string
      cwd: string
      executable: string
      executableSha256: string
      arguments: string[]
      environment: Record<string, string>
    }
    observerPolicy: {
      expectedExitCode: number
      output: 'exact' | 'nonempty' | 'exit-only'
      expectedStdoutSha256?: string
      expectedStderrSha256?: string
      checkoutMutation: 'forbidden'
      replay: 'required' | 'not-required' | 'prohibited'
    }
  }>
  [key: string]: unknown
}

export interface HardenedCommandExecutionArtifact {
  schemaVersion: 2
  artifactType: 'sop-command-execution-v2'
  producer: { name: '@xgh/engineering-governance'; version: string; policyDigest: string }
  taskId: string
  contract: { path: string; sha256: string; digest: string }
  acceptanceId: string
  evidenceKind: string
  gateDigest: string
  runId: string
  command: FrozenCommand
  repositoriesBefore: CheckoutSnapshot[]
  repositoriesAfter: CheckoutSnapshot[]
  startedAt: string
  endedAt: string
  exitCode: number
  environment: { node: string; platform: NodeJS.Platform; arch: string }
  stdout: string
  stderr: string
  stdoutSha256: string
  stderrSha256: string
  policyErrors: string[]
}

export type CommandExecutionArtifact = LegacyCommandExecutionArtifact | HardenedCommandExecutionArtifact

export function commandCheckId(command: ExactCommand): string {
  return `command:${canonicalDigest(command)}`
}

function sha256(input: string | Uint8Array): string {
  return createHash('sha256').update(input).digest('hex')
}

function execute(command: ExactCommand, environment: NodeJS.ProcessEnv = process.env): {
  startedAt: string
  endedAt: string
  exitCode: number
  stdout: string
  stderr: string
} {
  const startedAt = new Date().toISOString()
  const result = spawnSync(command.executable, command.arguments, {
    cwd: command.cwd,
    encoding: 'utf8',
    env: environment,
    maxBuffer: 64 * 1024 * 1024,
    shell: false,
  })
  return {
    startedAt,
    endedAt: new Date().toISOString(),
    exitCode: result.status ?? 70,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? result.error?.message ?? '',
  }
}

function prepareOutput(path: string): string {
  const outputPath = resolve(path)
  if (existsSync(outputPath)) {
    if (lstatSync(outputPath).isSymbolicLink()) {
      throw new Error('COMMAND_EXECUTION_OUTPUT_IS_SYMLINK')
    }
    throw new Error('COMMAND_EXECUTION_OUTPUT_EXISTS')
  }
  return outputPath
}

function writeArtifact(outputPath: string, artifact: CommandExecutionArtifact): void {
  mkdirSync(dirname(outputPath), { recursive: true })
  writeFileSync(outputPath, `${JSON.stringify(artifact, null, 2)}\n`, { flag: 'wx' })
}

function taskOutputPath(projectRoot: string, segments: string[]): string {
  let parent = realpathSync(projectRoot)
  for (const segment of segments.slice(0, -1)) {
    const next = join(parent, segment)
    if (existsSync(next)) {
      if (lstatSync(next).isSymbolicLink() || !lstatSync(next).isDirectory()) {
        throw new Error(`COMMAND_EXECUTION_OUTPUT_PARENT_UNSAFE:${segment}`)
      }
    } else {
      mkdirSync(next, { mode: 0o755 })
    }
    const canonical = realpathSync(next)
    const relativePath = relative(projectRoot, canonical)
    if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
      throw new Error('COMMAND_EXECUTION_OUTPUT_OUTSIDE_PROJECT')
    }
    parent = canonical
  }
  return prepareOutput(join(parent, segments.at(-1)!))
}

function captureLegacy(input: LegacyCommandExecutionInput): LegacyCommandExecutionArtifact {
  if (input.runId.trim().length === 0) throw new Error('COMMAND_EXECUTION_RUN_ID_REQUIRED')
  if (Object.hasOwn(input, 'checkIds')) {
    throw new Error('COMMAND_EXECUTION_CHECK_IDS_CALLER_CONTROLLED')
  }
  if (input.command.executable.trim().length === 0) {
    throw new Error('COMMAND_EXECUTION_EXECUTABLE_REQUIRED')
  }

  const outputPath = prepareOutput(input.outputPath)
  const command = {
    executable: input.command.executable,
    arguments: [...input.command.arguments],
    cwd: resolve(input.command.cwd),
  }
  const result = execute(command)
  const artifact: LegacyCommandExecutionArtifact = {
    schemaVersion: 1,
    artifactType: 'sop-command-execution-v1',
    producer: {
      name: '@xgh/engineering-governance',
      version: governanceIdentity().version,
    },
    runId: input.runId,
    command,
    startedAt: result.startedAt,
    endedAt: result.endedAt,
    exitCode: result.exitCode,
    environment: { node: process.versions.node, platform: process.platform, arch: process.arch },
    checks: [{
      id: commandCheckId(command),
      status: result.exitCode === 0 ? 'passed' : 'failed',
    }],
    stdout: result.stdout,
    stderr: result.stderr,
  }
  writeArtifact(outputPath, artifact)
  return artifact
}

function safeId(value: string, label: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) throw new Error(`${label}_INVALID`)
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const keys = Object.keys(value).sort()
  return JSON.stringify(keys) === JSON.stringify([...expected].sort())
}

function validateHardenedCommandExecutionInput(input: unknown): asserts input is HardenedCommandExecutionInput {
  if (!record(input) || input.schemaVersion !== 2) {
    throw new Error('LEGACY_EXECUTION_REQUIRES_PINNED_V1_RUNNER')
  }
  if (Object.hasOwn(input, 'command')) {
    throw new Error('COMMAND_EXECUTION_COMMAND_CALLER_CONTROLLED')
  }
  if (Object.hasOwn(input, 'contractPath') || Object.hasOwn(input, 'outputPath')) {
    throw new Error('COMMAND_EXECUTION_PATH_CALLER_CONTROLLED')
  }
  if (!exactKeys(input, ['acceptanceId', 'projectRoot', 'runId', 'schemaVersion', 'taskId'])
    || typeof input.projectRoot !== 'string'
    || input.projectRoot.length === 0
    || typeof input.taskId !== 'string'
    || typeof input.acceptanceId !== 'string'
    || typeof input.runId !== 'string') {
    throw new Error('COMMAND_EXECUTION_INPUT_INVALID')
  }
}

function readHardenedContract(input: HardenedCommandExecutionInput): {
  contract: HardenedContract
  raw: Buffer
  path: string
  projectRoot: string
} {
  safeId(input.taskId, 'COMMAND_EXECUTION_TASK_ID')
  const projectRoot = realpathSync(resolve(input.projectRoot))
  const unresolved = canonicalTaskPath(projectRoot, input.taskId, 'contract.yaml')
  if (!existsSync(unresolved) || lstatSync(unresolved).isSymbolicLink()) {
    throw new Error('CONTRACT_PATH_UNSAFE')
  }
  const contractPath = realpathSync(unresolved)
  if (lstatSync(contractPath).isSymbolicLink() || !lstatSync(contractPath).isFile()) {
    throw new Error('CONTRACT_PATH_UNSAFE')
  }
  const raw = readFileSync(contractPath)
  const contract = parse(raw.toString('utf8')) as HardenedContract
  const semantic = validateHardenedTaskContract(contract)
  if (!semantic.valid) throw new Error(`CONTRACT_INVALID:${semantic.errors.join(',')}`)
  const { contractDigest } = contract
  if (contract.taskId !== input.taskId) throw new Error('CONTRACT_TASK_ID_MISMATCH')
  const identity = governanceIdentity()
  if (contract.sopVersion !== identity.version || contract.policyDigest !== identity.digest) {
    throw new Error('CONTRACT_POLICY_IDENTITY_MISMATCH')
  }
  const ledger = readTaskLedger({
    projectRoot,
    taskId: input.taskId,
    contractDigest,
    contractSha256: sha256(raw),
    implementationOwners: implementationOwnersOf(contract),
  })
  if (!ledger.valid) throw new Error(`TASK_LEDGER_INVALID:${ledger.errors.join(',')}`)
  if (ledger.currentState !== 'DEFINED' && ledger.currentState !== 'IN_PROGRESS') {
    throw new Error(`TASK_STATE_NOT_EXECUTABLE:${ledger.currentState ?? 'UNKNOWN'}`)
  }
  return { contract, raw, path: contractPath, projectRoot }
}

function captureHardened(input: HardenedCommandExecutionInput): HardenedCommandExecutionArtifact {
  if (Object.hasOwn(input, 'command')) {
    throw new Error('COMMAND_EXECUTION_COMMAND_CALLER_CONTROLLED')
  }
  if (Object.hasOwn(input, 'contractPath') || Object.hasOwn(input, 'outputPath')) {
    throw new Error('COMMAND_EXECUTION_PATH_CALLER_CONTROLLED')
  }
  safeId(input.acceptanceId, 'COMMAND_EXECUTION_ACCEPTANCE_ID')
  safeId(input.runId, 'COMMAND_EXECUTION_RUN_ID')
  if (input.runId.trim().length === 0) throw new Error('COMMAND_EXECUTION_RUN_ID_REQUIRED')
  const loaded = readHardenedContract(input)
  const outputPath = taskOutputPath(loaded.projectRoot, [
    '.delivery', 'tasks', input.taskId, 'receipts', input.runId, `${input.acceptanceId}.json`,
  ])
  const gate = loaded.contract.acceptance.find((acceptance) => acceptance.id === input.acceptanceId)
  if (gate === undefined) throw new Error('COMMAND_EXECUTION_ACCEPTANCE_UNKNOWN')
  const repository = loaded.contract.repositories.find((candidate) => (
    candidate.id === gate.command.repositoryId
  ))
  if (repository === undefined) throw new Error('COMMAND_EXECUTION_REPOSITORY_UNKNOWN')
  const repositoryRoot = realpathSync(repository.path)
  const cwd = realpathSync(resolve(repositoryRoot, gate.command.cwd))
  const relativePath = relative(repositoryRoot, cwd)
  if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
    throw new Error('COMMAND_EXECUTION_CWD_OUTSIDE_REPOSITORY')
  }
  const command = {
    executable: gate.command.executable,
    executableSha256: gate.command.executableSha256,
    arguments: [...gate.command.arguments],
    cwd,
    environment: { ...gate.command.environment },
  }
  if (sha256(readFileSync(command.executable)) !== command.executableSha256) {
    throw new Error('COMMAND_EXECUTION_EXECUTABLE_DIGEST_MISMATCH')
  }
  const repositoriesBefore = captureRepositorySet(loaded.contract.repositories)
  const result = execute(command, command.environment)
  const repositoriesAfter = captureRepositorySet(loaded.contract.repositories)
  const policyErrors: string[] = []
  if (result.exitCode !== gate.observerPolicy.expectedExitCode) {
    policyErrors.push(`UNEXPECTED_EXIT_CODE:${gate.observerPolicy.expectedExitCode}:${result.exitCode}`)
  }
  if (
    gate.observerPolicy.output === 'nonempty'
    && result.stdout.length === 0
    && result.stderr.length === 0
  ) policyErrors.push('COMMAND_OUTPUT_EMPTY')
  if (gate.observerPolicy.output === 'exact') {
    if (sha256(result.stdout) !== gate.observerPolicy.expectedStdoutSha256) {
      policyErrors.push('COMMAND_STDOUT_EXACT_MISMATCH')
    }
    if (sha256(result.stderr) !== gate.observerPolicy.expectedStderrSha256) {
      policyErrors.push('COMMAND_STDERR_EXACT_MISMATCH')
    }
  }
  if (
    gate.observerPolicy.checkoutMutation === 'forbidden'
    && JSON.stringify(repositoriesBefore) !== JSON.stringify(repositoriesAfter)
  ) policyErrors.push('CHECKOUT_MUTATION_FORBIDDEN')

  const identity = governanceIdentity()
  const artifact: HardenedCommandExecutionArtifact = {
    schemaVersion: 2,
    artifactType: 'sop-command-execution-v2',
    producer: {
      name: '@xgh/engineering-governance',
      version: identity.version,
      policyDigest: identity.digest,
    },
    taskId: loaded.contract.taskId,
    contract: {
      path: loaded.path,
      sha256: sha256(loaded.raw),
      digest: loaded.contract.contractDigest,
    },
    acceptanceId: input.acceptanceId,
    evidenceKind: gate.evidenceKind,
    gateDigest: canonicalDigest(gate),
    runId: input.runId,
    command,
    repositoriesBefore,
    repositoriesAfter,
    startedAt: result.startedAt,
    endedAt: result.endedAt,
    exitCode: result.exitCode,
    environment: { node: process.versions.node, platform: process.platform, arch: process.arch },
    stdout: result.stdout,
    stderr: result.stderr,
    stdoutSha256: sha256(result.stdout),
    stderrSha256: sha256(result.stderr),
    policyErrors,
  }
  writeArtifact(outputPath, artifact)
  return artifact
}

export function captureCommandExecution(
  input: HardenedCommandExecutionInput,
): HardenedCommandExecutionArtifact
export function captureCommandExecution(input: HardenedCommandExecutionInput): HardenedCommandExecutionArtifact {
  validateHardenedCommandExecutionInput(input)
  return captureHardened(input)
}

export function captureLegacyCommandExecution(
  input: LegacyCommandExecutionInput,
): LegacyCommandExecutionArtifact {
  return captureLegacy(input)
}
