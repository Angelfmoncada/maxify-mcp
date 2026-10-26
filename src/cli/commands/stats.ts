import type { StatsRequest } from '../../engine/types.js';
import { definedOnly } from '../../mcp/requests.js';
import { enumOption, rejectPositionals } from '../args.js';
import { resolveCliCommand } from '../cliCommand.js';
import { printToolOutput, withEngine, type CommandSpec } from '../command.js';

const SCOPES = ['index', 'session', 'all'] as const;

export const statsCommand: CommandSpec = {
  name: 'stats',
  summary: 'Index health, session metrics, limitations and the tool-surface token overhead.',
  usage: 'stats [--scope index|session|all]',
  options: { scope: { type: 'string' } },
  optionDocs: [{ flag: '--scope S', description: `What to report: ${SCOPES.join(', ')}.` }],
  async run(call) {
    rejectPositionals(call.positionals);
    const request = definedOnly<StatsRequest>({ scope: enumOption(call.values, 'scope', SCOPES) });
    const { describeToolSurface, formatSurface } = await import('../../mcp/surface.js');
    return withEngine(call, false, async (engine) => {
      const output = await engine.stats(request);
      const surface = await describeToolSurface({
        version: call.deps.version,
        cliCommand: resolveCliCommand(call.deps.env, call.deps.cliPath),
      });
      return printToolOutput(call, {
        ...output,
        text: `${output.text}\n\n${formatSurface(surface)}`,
        meta: { ...output.meta, toolSurface: surface },
      });
    });
  },
};
