#!/usr/bin/env node

import { fileURLToPath } from 'node:url'
import { readFileSync, realpathSync } from 'node:fs'

import { Command } from 'commander'
import { parse } from 'yaml'

import { checkProject } from '../commands/check.js'
import { applyAdoption } from '../commands/init.js'
import { planAdoption, summarizeAdoptionPlan } from '../commands/adopt.js'
import { startTask, type TaskStartInput } from '../commands/task-start.js'
import {
  verifyCandidateEligibility,
  type CandidateEligibilityInput,
} from '../commands/task-verify.js'
import { verifyReviewEligibility, type ReviewEligibilityInput } from '../commands/task-review.js'
import { verifyCloseEligibility, type CloseEligibilityInput } from '../commands/task-close.js'
import { planUpgrade } from '../commands/upgrade.js'
import {
  applyGlobalInstall,
  checkGlobalInstall,
  planGlobalInstall,
  summarizeGlobalPlan,
} from '../commands/install-global.js'

export interface CliOutput {
  write(text: string): void
}

const defaultOutput: CliOutput = { write: (text) => process.stdout.write(text) }

function structuredFile<T>(path: string): T {
  return parse(readFileSync(path, 'utf8')) as T
}

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

  program.command('check')
    .argument('<project>')
    .option('--json')
    .action((project: string) => writeJson(output, checkProject(project)))

  adoptionCommand('upgrade')

  const task = program.command('task')
  task.command('start')
    .requiredOption('--input <path>')
    .action((options: { input: string }) => {
      writeJson(output, startTask(structuredFile<TaskStartInput>(options.input)))
    })
  task.command('verify')
    .requiredOption('--input <path>')
    .action((options: { input: string }) => {
      writeJson(
        output,
        verifyCandidateEligibility(structuredFile<CandidateEligibilityInput>(options.input)),
      )
    })
  task.command('review')
    .requiredOption('--input <path>')
    .action((options: { input: string }) => {
      writeJson(output, verifyReviewEligibility(structuredFile<ReviewEligibilityInput>(options.input)))
    })
  task.command('close')
    .requiredOption('--input <path>')
    .action((options: { input: string }) => {
      writeJson(output, verifyCloseEligibility(structuredFile<CloseEligibilityInput>(options.input)))
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
