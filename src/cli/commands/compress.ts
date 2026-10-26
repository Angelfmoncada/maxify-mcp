/**
 * `maxify compress [file]`: the shell-side twin of maxify_compress. With a
 * file or stdin the CLI reads the text itself and prints only the compressed
 * result on stdout, so it composes in pipelines: `<cmd> 2>&1 | maxify compress`.
 */
import path from 'node:path';
import type { CompressKindInput } from '../../compress/types.js';
import type { CompressRequest } from '../../engine/types.js';
import { LIMITS } from '../../mcp/limits.js';
import { definedOnly } from '../../mcp/requests.js';
import {
  UsageError,
  enumOption,
  integerOption,
  listOption,
  requireOnePositional,
  stringOption,
  type OptionValues,
} from '../args.js';
import { info, printResult, printToolOutput, withEngine, type CommandCall, type CommandSpec } from '../command.js';
import { MAX_INPUT_BYTES, readTextFile } from '../input.js';

const KINDS = ['auto', 'log', 'test', 'search', 'json', 'list', 'diff', 'text'] as const satisfies readonly CompressKindInput[];
const LINE_RANGE = /^\d{1,9}(?:-\d{1,9})?$/;

async function readInput(call: CommandCall): Promise<string> {
  const file = call.positionals.length > 0 ? requireOnePositional(call.positionals, 'file') : undefined;
  if (file !== undefined) return readTextFile(path.resolve(call.deps.cwd, file), MAX_INPUT_BYTES);
  if (call.deps.io.stdinIsTTY) {
    throw new UsageError('compress needs a file, piped stdin (<cmd> 2>&1 | maxify compress) or --ref');
  }
  return call.deps.io.readStdin();
}

function lineRange(values: OptionValues): string | undefined {
  const lines = stringOption(values, 'lines');
  if (lines !== undefined && !LINE_RANGE.test(lines)) {
    throw new UsageError(`--lines must look like START-END (got "${lines}")`);
  }
  return lines;
}

async function buildRequest(call: CommandCall): Promise<CompressRequest> {
  const { values, positionals } = call;
  const ref = stringOption(values, 'ref');
  const lines = lineRange(values);
  if (ref !== undefined && positionals.length > 0) throw new UsageError('use either a file or --ref, not both');
  if (ref === undefined && lines !== undefined) throw new UsageError('--lines needs --ref');
  const common = {
    kind: enumOption(values, 'kind', KINDS),
    maxTokens: integerOption(values, 'max-tokens', LIMITS.pageTokens),
    focus: listOption(values, 'focus'),
  };
  if (ref !== undefined) return definedOnly<CompressRequest>({ ref, lines, ...common });
  return definedOnly<CompressRequest>({ text: await readInput(call), ...common });
}

export const compressCommand: CommandSpec = {
  name: 'compress',
  summary: 'Compress long command output from a file or stdin, keeping every error line.',
  usage: 'compress [file] [--kind K] [--max-tokens N] [--focus a,b] [--ref HASH [--lines A-B]]',
  details: [
    'Without a file, reads stdin: <cmd> 2>&1 | maxify compress',
    'The result names a blob ref; --ref HASH [--lines A-B] prints the exact original lines.',
  ],
  options: {
    kind: { type: 'string' },
    'max-tokens': { type: 'string' },
    focus: { type: 'string', multiple: true },
    ref: { type: 'string' },
    lines: { type: 'string' },
  },
  optionDocs: [
    { flag: '--kind K', description: `Output type: ${KINDS.join(', ')}.` },
    { flag: '--max-tokens N', description: 'Target size of the result in estimated tokens.' },
    { flag: '--focus a,b', description: 'Terms whose lines are kept verbatim.' },
    { flag: '--ref HASH', description: 'Fetch the original of an earlier compression (blob:HASH or HASH).' },
    { flag: '--lines A-B', description: 'With --ref: only this line range of the original.' },
  ],
  async run(call) {
    const request = await buildRequest(call);
    if (request.text === '') {
      // A command that printed nothing is not an error in a pipeline; there is simply nothing to compress.
      info(call, 'no input; nothing to compress');
      return call.globals.json ? printResult(call, { text: '', meta: { empty: true } }) : 0;
    }
    return withEngine(call, false, async (engine) => printToolOutput(call, await engine.compress(request)));
  },
};
