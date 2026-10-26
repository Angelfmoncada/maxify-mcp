import type { ContextRequest } from '../../engine/types.js';
import { LIMITS } from '../../mcp/limits.js';
import { definedOnly } from '../../mcp/requests.js';
import {
  UsageError,
  booleanOption,
  enumOption,
  integerOption,
  listOption,
  requirePositionals,
  stringOption,
} from '../args.js';
import { printToolOutput, withEngine, type CommandSpec } from '../command.js';

const DETAIL_LEVELS = ['auto', 'map', 'signature', 'source'] as const;

export const queryCommand: CommandSpec = {
  name: 'query',
  summary: 'Ranked, budgeted context for a task (what maxify_context returns).',
  usage: 'query <task...> [--budget N] [--focus a,b] [--detail LEVEL] [--no-tests] [--cursor C]',
  options: {
    budget: { type: 'string' },
    focus: { type: 'string', multiple: true },
    detail: { type: 'string' },
    'no-tests': { type: 'boolean' },
    cursor: { type: 'string' },
  },
  optionDocs: [
    { flag: '--budget N', description: `Token budget for the result (${LIMITS.budget.min}-${LIMITS.budget.max}).` },
    { flag: '--focus a,b', description: 'Paths, path#Symbol or names to prioritize.' },
    { flag: '--detail LEVEL', description: `Highest detail level: ${DETAIL_LEVELS.join(', ')}.` },
    { flag: '--no-tests', description: 'Leave out related tests.' },
    { flag: '--cursor C', description: 'Continue a previous incomplete result.' },
  ],
  async run(call) {
    const task = requirePositionals(call.positionals, 'task').join(' ').trim();
    if (task.length > LIMITS.taskChars) {
      throw new UsageError(`task is ${task.length} characters; the limit is ${LIMITS.taskChars}`);
    }
    const request = definedOnly<ContextRequest>({
      task,
      budget: integerOption(call.values, 'budget', LIMITS.budget),
      focus: listOption(call.values, 'focus'),
      detail: enumOption(call.values, 'detail', DETAIL_LEVELS),
      includeTests: booleanOption(call.values, 'no-tests') ? false : undefined,
      cursor: stringOption(call.values, 'cursor'),
    });
    return withEngine(call, undefined, async (engine) => printToolOutput(call, await engine.context(request)));
  },
};
