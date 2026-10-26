import type { MaxifyEngine } from '../../engine/types.js';
import { booleanOption, rejectPositionals } from '../args.js';
import { resolveCliCommand } from '../cliCommand.js';
import { closeQuietly, engineOptions, info, locate, type CommandCall, type CommandSpec } from '../command.js';

async function serveEngine(call: CommandCall, engine: MaxifyEngine): Promise<void> {
  const { deps } = call;
  try {
    const handle = await deps.serve(engine, {
      version: deps.version,
      cliCommand: resolveCliCommand(deps.env, deps.cliPath),
      index: !booleanOption(call.values, 'no-index'),
    });
    await handle.closed;
  } catch (error: unknown) {
    closeQuietly(engine);
    throw error;
  }
}

export const serveCommand: CommandSpec = {
  name: 'serve',
  summary: 'Run the MCP server on stdio (started by Claude Code).',
  usage: 'serve [--no-index]',
  details: [
    'stdout carries only MCP JSON-RPC; diagnostics go to stderr.',
    'The project is --root, else $MAXIFY_ROOT, else $CLAUDE_PROJECT_DIR (set by Claude Code), else detected from the current directory.',
  ],
  options: { 'no-index': { type: 'boolean' } },
  optionDocs: [{ flag: '--no-index', description: 'Skip the background index normally started after connecting.' }],
  async run(call) {
    rejectPositionals(call.positionals);
    // Anything printed to stdout from here on would corrupt the JSON-RPC stream, engine start-up included.
    const { redirectConsoleToStderr } = await import('../../mcp/stdio.js');
    const restoreConsole = redirectConsoleToStderr();
    try {
      const location = locate(call);
      if (call.deps.io.stdinIsTTY) {
        info(call, 'MCP server on stdio; an MCP client such as Claude Code starts it. Ctrl+C stops it.');
      }
      await serveEngine(call, await call.deps.openEngine(engineOptions(location, false)));
      return 0;
    } finally {
      restoreConsole();
    }
  },
};
