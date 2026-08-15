#!/usr/bin/env node

import { fileURLToPath } from 'node:url'
import { realpathSync } from 'node:fs'

import { Command } from 'commander'

import { checkProject } from '../commands/check.js'
import { applyAdoption } from '../commands/init.js'
import { planAdoption, summarizeAdoptionPlan } from '../commands/adopt.js'
import {
  applyTaskStart,
  planTaskStart,
  type TaskStartInput,
} from '../commands/task-start.js'
import {
  verifyCandidateEligibility,
} from '../commands/task-verify.js'
import {
  persistHardenedVerificationArtifact,
  type HardenedCandidateEligibilityInput,
} from '../commands/task-verify-v2.js'
import { applyCandidateReplay, planCandidateReplay } from '../commands/task-replay-v2.js'
import {
  applyOwnerTaskTransition,
  planOwnerTaskTransition,
} from '../commands/task-transition-v2.js'
import { verifyHardenedReview } from '../commands/task-review-v2.js'
import { verifyContractReview } from '../commands/task-contract-review-v2.js'
import { verifyHardenedClose } from '../commands/task-close-v2.js'
import {
  captureCommandExecution,
  type HardenedCommandExecutionInput,
} from '../evidence/capture.js'
import { planUpgrade } from '../commands/upgrade.js'
import {
  applyUnadoption,
  planUnadoption,
  summarizeUnadoptionPlan,
} from '../commands/unadopt.js'
import {
  applyGlobalInstall,
  checkGlobalInstall,
  planGlobalInstall,
  summarizeGlobalPlan,
} from '../commands/install-global.js'
import { loadCliInput, requireActiveV2 } from './input.js'
import { inspectLegacyDocument } from './legacy-inspect.js'
import { loadAdoptedProjectContext } from './project-context.js'
import { applyCliTransition } from './transition.js'

export interface CliOutput {
  write(text: string): void
}

const defaultOutput: CliOutput = { write: (text) => process.stdout.write(text) }

function writeJson(output: CliOutput, value: unknown): void {
  if (
    typeof value === 'object'
    && value !== null
    && 'valid' in value
    && value.valid === false
  ) {
    process.exitCode = 1
  }
  output.write(`${JSON.stringify(value, null, 2)}\n`)
}

export function normalizeCliArguments(arguments_: string[]): string[] {
  return arguments_[2] === '--'
    ? [...arguments_.slice(0, 2), ...arguments_.slice(3)]
    : arguments_
}

export function buildProgram(output: CliOutput = defaultOutput): Command {
  const program = new Command().name('sop')

  const adoptionCommand = (name: 'init' | 'adopt' | 'upgrade'): void => {
    program.command(name)
      .argument('<project>')
      .option('--json')
      .option('--runner-bundle <path>')
      .option('--apply-plan <digest>')
      .action((project: string, options: { applyPlan?: string; runnerBundle?: string }) => {
        const planOptions = options.runnerBundle === undefined
          ? {}
          : { runnerBundlePath: options.runnerBundle }
        const plan = name === 'upgrade'
          ? planUpgrade(project, planOptions)
          : planAdoption(project, planOptions)
        if (options.applyPlan) {
          writeJson(output, applyAdoption(plan, options.applyPlan))
        } else {
          writeJson(output, summarizeAdoptionPlan(plan))
        }
      })
  }
  adoptionCommand('init')
  adoptionCommand('adopt')

  program.command('unadopt')
    .argument('<project>')
    .option('--apply-plan <digest>')
    .action((project: string, options: { applyPlan?: string }) => {
      const plan = planUnadoption(project)
      writeJson(
        output,
        options.applyPlan === undefined
          ? summarizeUnadoptionPlan(plan)
          : applyUnadoption(plan, options.applyPlan),
      )
    })

  program.command('check')
    .argument('<project>')
    .option('--json')
    .action((project: string) => writeJson(output, checkProject(project)))

  adoptionCommand('upgrade')

  const task = program.command('task')
  task.command('start')
    .requiredOption('--input <path>')
    .requiredOption('--project <path>')
    .option('--apply-plan <digest>')
    .action((options: { input: string; project: string; applyPlan?: string }) => {
      const context = loadAdoptedProjectContext(options.project)
      const input = loadCliInput<TaskStartInput>(options.input)
      requireActiveV2(input.value)
      const plan = planTaskStart(
        context.projectRoot,
        input.value,
        { projectExtensions: context.projectExtensions },
      )
      writeJson(output, options.applyPlan === undefined
        ? plan
        : applyTaskStart(plan, options.applyPlan))
    })
  task.command('verify')
    .requiredOption('--input <path>')
    .option('--persist')
    .action((options: { input: string; persist?: boolean }) => {
      const input = loadCliInput<HardenedCandidateEligibilityInput>(options.input)
      requireActiveV2(input.value)
      const decision = verifyCandidateEligibility(input.value, { candidatePath: input.unresolvedPath })
      if (options.persist === true && decision.valid && decision.verificationArtifact !== undefined) {
        writeJson(output, {
          ...decision,
          persistedVerification: persistHardenedVerificationArtifact(decision.verificationArtifact),
        })
        return
      }
      writeJson(output, decision)
    })
  task.command('replay')
    .requiredOption('--input <path>')
    .option('--apply-plan <digest>')
    .action((options: { input: string; applyPlan?: string }) => {
      const input = loadCliInput<unknown>(options.input)
      requireActiveV2(input.value)
      const plan = planCandidateReplay(input.unresolvedPath)
      if (options.applyPlan === undefined) {
        writeJson(output, plan)
        return
      }
      const result = applyCandidateReplay(plan, options.applyPlan)
      writeJson(output, result)
      if (result.artifact.decision !== 'eligible') process.exitCode = 1
    })
  task.command('execute')
    .requiredOption('--input <path>')
    .action((options: { input: string }) => {
      const input = loadCliInput<HardenedCommandExecutionInput>(options.input)
      requireActiveV2(input.value)
      const artifact = captureCommandExecution(input.value)
      writeJson(output, artifact)
      if (artifact.policyErrors.length > 0) process.exitCode = 1
    })
  task.command('transition')
    .requiredOption('--input <path>')
    .option('--apply-plan <digest>')
    .action((options: { input: string; applyPlan?: string }) => {
      const input = loadCliInput<unknown>(options.input)
      requireActiveV2(input.value)
      const plan = planOwnerTaskTransition(input.value)
      writeJson(
        output,
        options.applyPlan === undefined
          ? plan
          : applyOwnerTaskTransition(plan, options.applyPlan),
      )
    })
  task.command('contract-review')
    .requiredOption('--input <path>')
    .action((options: { input: string }) => {
      const input = loadCliInput<unknown>(options.input)
      writeJson(output, verifyContractReview(input.unresolvedPath))
    })
  task.command('review')
    .requiredOption('--input <path>')
    .option('--apply-plan <digest>')
    .action((options: { input: string; applyPlan?: string }) => {
      const input = loadCliInput<unknown>(options.input)
      requireActiveV2(input.value)
      writeJson(
        output,
        applyCliTransition(verifyHardenedReview(input.unresolvedPath), options.applyPlan),
      )
    })
  task.command('close')
    .requiredOption('--input <path>')
    .option('--apply-plan <digest>')
    .action((options: { input: string; applyPlan?: string }) => {
      const input = loadCliInput<unknown>(options.input)
      requireActiveV2(input.value)
      writeJson(
        output,
        applyCliTransition(verifyHardenedClose(input.unresolvedPath), options.applyPlan),
      )
    })

  const legacy = program.command('legacy')
  legacy.command('inspect')
    .requiredOption('--input <path>')
    .action((options: { input: string }) => {
      writeJson(output, inspectLegacyDocument(loadCliInput<unknown>(options.input).value))
    })

  const global = program.command('global')
  global.command('install')
    .requiredOption('--tool <tool>')
    .option('--home <path>')
    .option('--apply-plan <digest>')
    .action((options: { tool: string; home?: string; applyPlan?: string }) => {
      const plan = planGlobalInstall({
        tool: options.tool,
        ...(options.home === undefined ? {} : { homeDirectory: options.home }),
      })
      writeJson(
        output,
        options.applyPlan
          ? applyGlobalInstall(plan, options.applyPlan)
          : summarizeGlobalPlan(plan),
      )
    })
  global.command('check')
    .requiredOption('--tool <tool>')
    .option('--home <path>')
    .action((options: { tool: string; home?: string }) => {
      writeJson(output, checkGlobalInstall({
        tool: options.tool,
        ...(options.home === undefined ? {} : { homeDirectory: options.home }),
      }))
    })

  return program
}

if (
  process.argv[1]
  && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])
) {
  await buildProgram().parseAsync(normalizeCliArguments(process.argv))
}
