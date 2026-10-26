import path from 'node:path';
import { LIMITS } from '../../mcp/limits.js';
import { UsageError, enumOption, listOption, rejectPositionals, stringOption } from '../args.js';
import { printResult, type CommandCall, type CommandSpec } from '../command.js';

const SUITES = ['offline', 'agent'] as const;

export const AGENT_BENCH_NOTICE = [
  'The paid agent benchmark is not run by "maxify bench".',
  'It lives in bench/agent of the Maxify repository, calls the Claude API and costs money.',
  'Run its dry run first: it prints the planned runs and the cost estimate without calling any API.',
  'See bench/agent/README.md for the exact commands.',
].join('\n');

function parseBudgets(call: CommandCall): number[] | undefined {
  const items = listOption(call.values, 'budget');
  if (items === undefined) return undefined;
  return items.map((item) => {
    const value = /^\d+$/.test(item) ? Number(item) : Number.NaN;
    if (!Number.isSafeInteger(value) || value < LIMITS.budget.min || value > LIMITS.budget.max) {
      throw new UsageError(`--budget values must be integers from ${LIMITS.budget.min} to ${LIMITS.budget.max} (got "${item}")`);
    }
    return value;
  });
}

export const benchCommand: CommandSpec = {
  name: 'bench',
  summary: 'Run the offline benchmark (agent suite: prints how to dry-run it).',
  usage: 'bench [--suite offline|agent] [--budget 2000,4000] [--out file]',
  options: {
    suite: { type: 'string' },
    budget: { type: 'string', multiple: true },
    out: { type: 'string' },
  },
  optionDocs: [
    { flag: '--suite S', description: 'offline (default): deterministic, free. agent: paid; only explained here.' },
    { flag: '--budget a,b', description: 'Token budgets to evaluate for maxify_context.' },
    { flag: '--out file', description: 'Write the Markdown report here (and a .json next to it).' },
  ],
  async run(call) {
    rejectPositionals(call.positionals);
    const suite = enumOption(call.values, 'suite', SUITES) ?? 'offline';
    if (suite === 'agent') return printResult(call, { text: AGENT_BENCH_NOTICE, meta: { suite, executed: false } });
    const budgets = parseBudgets(call);
    const out = stringOption(call.values, 'out');
    const result = await call.deps.runOfflineBench({
      ...(budgets === undefined ? {} : { budgets }),
      ...(out === undefined ? {} : { out: path.resolve(call.deps.cwd, out) }),
    });
    printResult(call, { text: result.text, meta: { suite, exitCode: result.exitCode, budgets: budgets ?? null } });
    if (result.exitCode === 0) return 0;
    // The suite's own codes (2, 3, ...) would collide with the CLI's "2 = usage error"; failure is 1.
    call.deps.io.err(`maxify: the offline benchmark reported failure (suite exit code ${result.exitCode})\n`);
    return 1;
  },
};
