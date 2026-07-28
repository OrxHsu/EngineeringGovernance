import { pathToFileURL } from 'node:url'

import { Command } from 'commander'

export function buildProgram(): Command {
  const program = new Command().name('sop')

  for (const name of ['init', 'adopt', 'check', 'upgrade']) {
    program.command(name)
  }
  program.command('task')

  return program
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await buildProgram().parseAsync()
}
