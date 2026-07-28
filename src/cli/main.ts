import { pathToFileURL } from 'node:url'
import { readFileSync } from 'node:fs'

import { Command } from 'commander'
import { parse } from 'yaml'

import { checkProject } from '../commands/check.js'
import { applyAdoption } from '../commands/init.js'
import { planAdoption } from '../commands/adopt.js'
import { startTask, type TaskStartInput } from '../commands/task-start.js'
import {
  verifyCandidateEligibility,
  type CandidateEligibilityInput,
} from '../commands/task-verify.js'
import { verifyReviewEligibility, type ReviewEligibilityInput } from '../commands/task-review.js'
import { verifyCloseEligibility, type CloseEligibilityInput } from '../commands/task-close.js'
import { planUpgrade } from '../commands/upgrade.js'

export interface CliOutput {
  write(text: string): void
}

const defaultOutput: CliOutput = { write: (text) => process.stdout.write(text) }

function structuredFile<T>(path: string): T {
  return parse(readFileSync(path, 'utf8')) as T
}

function writeJson(output: CliOutput, value: unknown): void {
  output.write(`${JSON.stringify(value, null, 2)}\n`)
}

export function buildProgram(output: CliOutput = defaultOutput): Command {
  const program = new Command().name('sop')

  const adoptionCommand = (name: 'init' | 'adopt' | 'upgrade'): void => {
    program.command(name)
      .argument('<project>')
      .option('--json')
      .option('--apply-plan <digest>')
      .action((project: string, options: { applyPlan?: string }) => {
        const plan = name === 'upgrade' ? planUpgrade(project) : planAdoption(project)
        if (options.applyPlan) {
          writeJson(output, applyAdoption(plan, options.applyPlan))
        } else {
          writeJson(output, plan)
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

  return program
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await buildProgram().parseAsync()
}
