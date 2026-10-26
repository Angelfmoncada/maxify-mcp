import type { ImpactRequest } from '../../engine/types.js';
import { LIMITS } from '../../mcp/limits.js';
import { definedOnly } from '../../mcp/requests.js';
import { integerOption, requirePositionals } from '../args.js';
import { printToolOutput, withEngine, type CommandSpec } from '../command.js';

export const impactCommand: CommandSpec = {
  name: 'impact',
  summary: 'Dependents, affected tests and exported API for planned changes (maxify_impact).',
  usage: 'impact <targets...> [--depth N] [--budget N]',
  details: ['Each <target> is a path or path#Symbol that will change.'],
  options: {
    depth: { type: 'string' },
    budget: { type: 'string' },
  },
  optionDocs: [
    { flag: '--depth N', description: `Transitive dependent depth (${LIMITS.depth.min}-${LIMITS.depth.max}).` },
    { flag: '--budget N', description: `Token budget for the result (${LIMITS.budget.min}-${LIMITS.budget.max}).` },
  ],
  async run(call) {
    const targets = requirePositionals(call.positionals, 'target', LIMITS.targets.max);
    const request = definedOnly<ImpactRequest>({
      targets,
      depth: integerOption(call.values, 'depth', LIMITS.depth),
      budget: integerOption(call.values, 'budget', LIMITS.budget),
    });
    return withEngine(call, undefined, async (engine) => printToolOutput(call, await engine.impact(request)));
  },
};
