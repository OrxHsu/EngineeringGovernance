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
import { runTaskPreflight } from '../commands/task-preflight.js'
import { accountabilityStatus } from '../commands/accountability-status.js'
import { accountabilityGates } from '../commands/accountability-gates.js'
import { accountabilityRecoveryPlan } from '../commands/accountability-recovery-plan.js'
import {
  applyAccountabilityBootstrap,
  planAccountabilityBootstrap,
  summarizeAccountabilityBootstrapPlan,
} from '../commands/accountability-bootstrap.js'
import {
  applyAccountabilityIncident,
  planAccountabilityIncident,
  summarizeAccountabilityIncidentPlan,
} from '../commands/accountability-incident.js'
import { verifyCleanTask } from '../commands/task-verify-clean.js'
import { contractSelfCheck } from '../commands/contract-self-check.js'
import { buildContractReviewRequest } from '../review/contract-review-assist.js'
import { formatReviewSummary, generateReviewSummary } from '../commands/task-review-summary.js'
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
  task.command('preflight')
    .requiredOption('--project <path>')
    .requiredOption('--input <path>')
    .action((options: { project: string; input: string }) => {
      writeJson(output, runTaskPreflight({ projectRoot: options.project, inputPath: options.input }))
    })
  task.command('start')
    .requiredOption('--input <path>')
    .requiredOption('--project <path>')
    .option('--preflight-plan <digest>')
    .option('--apply-plan <digest>')
    .action((options: { input: string; project: string; preflightPlan?: string; applyPlan?: string }) => {
      const context = loadAdoptedProjectContext(options.project)
      const input = loadCliInput<TaskStartInput>(options.input)
      requireActiveV2(input.value)
      const beta1Input = input.value.contractAuthor !== undefined
        || input.value.designBindings !== undefined
        || input.value.predecessors !== undefined
      const preflight = beta1Input
        ? runTaskPreflight({ projectRoot: context.projectRoot, inputPath: input.unresolvedPath })
        : undefined
      if (beta1Input && (!preflight?.valid || preflight.plan === undefined || options.preflightPlan !== preflight.plan.planDigest)) {
        throw new Error('TASK_START_PREFLIGHT_PLAN_MISMATCH')
      }
      const plan = planTaskStart(
        context.projectRoot,
        input.value,
        {
          projectExtensions: context.projectExtensions,
          ...(preflight?.plan === undefined ? {} : { contractPreflight: preflight.plan }),
        },
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
  task.command('contract-review-request')
    .requiredOption('--project <path>')
    .requiredOption('--task-id <id>')
    .action((options: { project: string; taskId: string }) => {
      writeJson(output, buildContractReviewRequest(options.project, options.taskId))
    })
  task.command('review-summary')
    .requiredOption('--project <path>')
    .requiredOption('--task-id <id>')
    .option('--json')
    .action((options: { project: string; taskId: string; json?: boolean }) => {
      const summary = generateReviewSummary(options.project, options.taskId)
      if (options.json === true) writeJson(output, summary)
      else output.write(`${formatReviewSummary(summary)}\n`)
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
  task.command('verify-clean')
    .requiredOption('--project <path>')
    .requiredOption('--task-id <id>')
    .action((options: { project: string; taskId: string }) => {
      writeJson(output, verifyCleanTask(options.project, options.taskId))
    })

  const contract = program.command('contract')
  contract.command('self-check')
    .requiredOption('--input <path>')
    .option('--response <path>')
    .action((options: { input: string; response?: string }) => {
      writeJson(output, contractSelfCheck(options.input, options.response))
    })

  const accountability = program.command('accountability')
  accountability.command('status')
    .requiredOption('--project <path>')
    .requiredOption('--actor <id-or-alias>')
    .action((options: { project: string; actor: string }) => {
      writeJson(output, accountabilityStatus(options.project, options.actor))
    })
  accountability.command('gates')
    .requiredOption('--project <path>')
    .requiredOption('--actor <id-or-alias>')
    .action((options: { project: string; actor: string }) => {
      writeJson(output, accountabilityGates(options.project, options.actor))
    })
  accountability.command('recovery-plan')
    .requiredOption('--project <path>')
    .requiredOption('--actor <id-or-alias>')
    .action((options: { project: string; actor: string }) => {
      writeJson(output, accountabilityRecoveryPlan(options.project, options.actor))
    })
  accountability.command('bootstrap')
    .requiredOption('--project <path>')
    .requiredOption('--input <path>')
    .option('--apply-plan <digest>')
    .action((options: { project: string; input: string; applyPlan?: string }) => {
      const plan = planAccountabilityBootstrap(options.project, options.input)
      writeJson(output, options.applyPlan === undefined
        ? summarizeAccountabilityBootstrapPlan(plan)
        : applyAccountabilityBootstrap(plan, options.applyPlan))
    })
  accountability.command('incident-record')
    .requiredOption('--project <path>')
    .requiredOption('--input <path>')
    .option('--apply-plan <digest>')
    .action((options: { project: string; input: string; applyPlan?: string }) => {
      const plan = planAccountabilityIncident(options.project, options.input)
      writeJson(output, options.applyPlan === undefined
        ? summarizeAccountabilityIncidentPlan(plan)
        : applyAccountabilityIncident(plan, options.applyPlan))
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
