import type { SourceRequest } from '../../engine/types.js';
import { LIMITS } from '../../mcp/limits.js';
import { definedOnly } from '../../mcp/requests.js';
import { integerOption, requireOnePositional } from '../args.js';
import { printToolOutput, withEngine, type CommandSpec } from '../command.js';

export const sourceCommand: CommandSpec = {
  name: 'source',
  summary: 'Exact, fresh source for a ref (what maxify_source returns).',
  usage: 'source <ref> [--context-lines N] [--max-tokens N]',
  details: ['<ref> is one of: path, path:START-END, path:LINE, path#Qual.Name, Name, blob:HASH.'],
  options: {
    'context-lines': { type: 'string' },
    'max-tokens': { type: 'string' },
  },
  optionDocs: [
    {
      flag: '--context-lines N',
      description: `Extra lines before and after (${LIMITS.contextLines.min}-${LIMITS.contextLines.max}).`,
    },
    { flag: '--max-tokens N', description: 'Page size in estimated tokens; longer sources are paginated.' },
  ],
  async run(call) {
    const ref = requireOnePositional(call.positionals, 'ref');
    const request = definedOnly<SourceRequest>({
      ref,
      contextLines: integerOption(call.values, 'context-lines', LIMITS.contextLines),
      maxTokens: integerOption(call.values, 'max-tokens', LIMITS.pageTokens),
    });
    return withEngine(call, undefined, async (engine) => printToolOutput(call, await engine.source(request)));
  },
};
