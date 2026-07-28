import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

import { governanceIdentity } from '../commands/adopt.js'
import { canonicalDigest } from '../model/digest.js'

export interface ExactCommand {
  executable: string
  arguments: string[]
  cwd: string
}

export interface CommandExecutionInput {
  schemaVersion: 1
  runId: string
  command: ExactCommand
  outputPath: string
}

export interface CommandExecutionArtifact {
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

export function commandCheckId(command: ExactCommand): string {
  return `command:${canonicalDigest(command)}`
}

export function captureCommandExecution(input: CommandExecutionInput): CommandExecutionArtifact {
  if (input.schemaVersion !== 1) throw new Error('COMMAND_EXECUTION_SCHEMA_INVALID')
  if (input.runId.trim().length === 0) throw new Error('COMMAND_EXECUTION_RUN_ID_REQUIRED')
  if (Object.hasOwn(input, 'checkIds')) {
    throw new Error('COMMAND_EXECUTION_CHECK_IDS_CALLER_CONTROLLED')
  }
  if (input.command.executable.trim().length === 0) {
    throw new Error('COMMAND_EXECUTION_EXECUTABLE_REQUIRED')
  }

  const outputPath = resolve(input.outputPath)
  if (existsSync(outputPath)) {
    if (lstatSync(outputPath).isSymbolicLink()) {
      throw new Error('COMMAND_EXECUTION_OUTPUT_IS_SYMLINK')
    }
    throw new Error('COMMAND_EXECUTION_OUTPUT_EXISTS')
  }
  const command = {
    executable: input.command.executable,
    arguments: [...input.command.arguments],
    cwd: resolve(input.command.cwd),
  }
  const startedAt = new Date().toISOString()
  const result = spawnSync(command.executable, command.arguments, {
    cwd: command.cwd,
    encoding: 'utf8',
    env: process.env,
    maxBuffer: 64 * 1024 * 1024,
    shell: false,
  })
  const endedAt = new Date().toISOString()
  const exitCode = result.status ?? 70
  const artifact: CommandExecutionArtifact = {
    schemaVersion: 1,
    artifactType: 'sop-command-execution-v1',
    producer: {
      name: '@xgh/engineering-governance',
      version: governanceIdentity().version,
    },
    runId: input.runId,
    command,
    startedAt,
    endedAt,
    exitCode,
    environment: { node: process.versions.node, platform: process.platform, arch: process.arch },
    checks: [{
      id: commandCheckId(command),
      status: exitCode === 0 ? 'passed' : 'failed',
    }],
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? result.error?.message ?? '',
  }
  mkdirSync(dirname(outputPath), { recursive: true })
  writeFileSync(outputPath, `${JSON.stringify(artifact, null, 2)}\n`, { flag: 'wx' })
  return artifact
}
