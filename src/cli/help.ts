import type { CommandSpec } from './command.js';

const GLOBAL_OPTION_DOCS: ReadonlyArray<readonly [string, string]> = [
  ['--root <dir>', 'Repository root. Default: $MAXIFY_ROOT, $CLAUDE_PROJECT_DIR, else detected from the current directory.'],
  ['--state-dir <dir>', 'Index and blob directory. Default: a per-repository directory under the Maxify home.'],
  ['--config <file>', 'Config file. Default: <root>/maxify.config.json when present.'],
  ['-q, --quiet', 'Print only errors and command output.'],
  ['--json', 'Print {"text", "meta"} as JSON on stdout. Errors stay plain text on stderr.'],
  ['-h, --help', 'Show help.'],
  ['-v, --version', 'Show the version.'],
];

const EXIT_CODES = 'Exit codes: 0 ok, 1 error (message on stderr), 2 usage error.';

function table(rows: ReadonlyArray<readonly [string, string]>, indent = 2): string {
  const width = Math.max(...rows.map(([left]) => left.length));
  return rows.map(([left, right]) => `${' '.repeat(indent)}${left.padEnd(width)}  ${right}`).join('\n');
}

export function renderGeneralHelp(version: string, commands: readonly CommandSpec[]): string {
  const rows = commands.map((command): readonly [string, string] => [command.name, command.summary]);
  return [
    `maxify ${version} - local MCP server and CLI that gives Claude Code exact, budgeted code context.`,
    '',
    'Usage: maxify [global options] <command> [options]',
    '',
    'Commands:',
    table(rows),
    '',
    'Global options:',
    table(GLOBAL_OPTION_DOCS),
    '',
    'Run "maxify <command> --help" for command options.',
    EXIT_CODES,
    '',
  ].join('\n');
}

export function renderCommandHelp(command: CommandSpec): string {
  const sections = [`Usage: maxify ${command.usage}`, '', command.summary];
  if (command.details !== undefined && command.details.length > 0) sections.push('', ...command.details);
  if (command.optionDocs.length > 0) {
    sections.push('', 'Options:', table(command.optionDocs.map((doc): readonly [string, string] => [doc.flag, doc.description])));
  }
  sections.push('', 'Global options:', table(GLOBAL_OPTION_DOCS), '', EXIT_CODES, '');
  return sections.join('\n');
}
