/**
 * CLI entry logic. `main` never calls process.exit: it returns the exit code
 * (0 ok, 1 error, 2 usage error) and every side effect goes through CliDeps.
 */
import { UsageError, parseCommandOptions, splitCommandLine } from './args.js';
import type { CommandCall, CommandSpec } from './command.js';
import { findCommand, COMMANDS } from './commands/registry.js';
import { createDefaultDeps, type CliDeps } from './deps.js';
import { renderCommandHelp, renderGeneralHelp } from './help.js';

export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_USAGE = 2;

function reportFailure(error: unknown, deps: CliDeps): number {
  const debug = deps.env.MAXIFY_DEBUG === '1';
  if (error instanceof UsageError) {
    const helpCommand = error.command === undefined ? 'maxify --help' : `maxify ${error.command} --help`;
    deps.io.err(`maxify: ${error.message}\nRun "${helpCommand}" for usage.\n`);
    return EXIT_USAGE;
  }
  if (error instanceof Error) {
    deps.io.err(`maxify: ${error.message}\n${debug && error.stack ? `${error.stack}\n` : ''}`);
    return EXIT_ERROR;
  }
  deps.io.err(`maxify: ${String(error)}\n`);
  return EXIT_ERROR;
}

function helpFor(name: string | undefined, deps: CliDeps): string {
  if (name === undefined) return renderGeneralHelp(deps.version, COMMANDS);
  const command = findCommand(name);
  if (command === undefined) throw new UsageError(`unknown command "${name}"`);
  return renderCommandHelp(command);
}

function resolveCommand(name: string): CommandSpec {
  const command = findCommand(name);
  if (command === undefined) throw new UsageError(`unknown command "${name}"`);
  return command;
}

async function run(argv: readonly string[], deps: CliDeps): Promise<number> {
  if (argv.length === 0) {
    deps.io.out(helpFor(undefined, deps));
    return EXIT_OK;
  }
  const split = splitCommandLine(argv);
  if (split.command === undefined) {
    if (split.globals.version) return printVersion(deps);
    if (split.globals.help) {
      deps.io.out(helpFor(undefined, deps));
      return EXIT_OK;
    }
    throw new UsageError('missing command');
  }
  if (split.command === 'help') {
    // Parse the rest so that values of global options (--config c.json) are not mistaken for a topic.
    const { positionals } = parseCommandOptions(split.rest, {});
    deps.io.out(helpFor(positionals[0], deps));
    return EXIT_OK;
  }
  const command = resolveCommand(split.command);
  try {
    return await runCommand(command, split.rest, deps);
  } catch (error: unknown) {
    throw error instanceof UsageError ? error.forCommand(command.name) : error;
  }
}

async function runCommand(command: CommandSpec, rest: readonly string[], deps: CliDeps): Promise<number> {
  const parsed = parseCommandOptions(rest, command.options);
  if (parsed.globals.version) return printVersion(deps);
  if (parsed.globals.help) {
    deps.io.out(renderCommandHelp(command));
    return EXIT_OK;
  }
  if (parsed.globals.quiet) deps.env.MAXIFY_QUIET = '1';
  const call: CommandCall = { globals: parsed.globals, values: parsed.values, positionals: parsed.positionals, deps };
  return command.run(call);
}

function printVersion(deps: CliDeps): number {
  deps.io.out(`${deps.version}\n`);
  return EXIT_OK;
}

/** Run the CLI and return the process exit code. */
export async function main(argv: readonly string[], deps: CliDeps = createDefaultDeps()): Promise<number> {
  try {
    return await run(argv, deps);
  } catch (error: unknown) {
    return reportFailure(error, deps);
  }
}
