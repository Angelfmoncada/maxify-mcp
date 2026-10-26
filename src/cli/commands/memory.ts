import type { MemoryOp, MemoryRequest } from '../../engine/types.js';
import { LIMITS, SINGLE_LINE_TEXT } from '../../mcp/limits.js';
import { definedOnly } from '../../mcp/requests.js';
import { UsageError, enumOption, integerOption, listOption, requireOnePositional, stringOption } from '../args.js';
import { printToolOutput, withEngine, type CommandCall, type CommandSpec } from '../command.js';

const OPS = ['add', 'search', 'list', 'get', 'update', 'delete'] as const satisfies readonly MemoryOp[];
const KINDS = ['fact', 'note', 'decision'] as const;
const ORIGINS = ['agent', 'user'] as const;

/** Options each op cannot work without; a missing one is a usage error (exit 2), not an engine failure. */
const REQUIRED_BY_OP: Readonly<Record<MemoryOp, readonly string[]>> = {
  add: ['text'],
  search: ['query'],
  list: [],
  get: ['id'],
  update: ['id'],
  delete: ['id'],
};

function buildRequest(call: CommandCall): MemoryRequest {
  const op = requireOnePositional(call.positionals, `operation (${OPS.join('|')})`);
  const checked = OPS.find((candidate) => candidate === op);
  if (checked === undefined) throw new UsageError(`unknown memory operation "${op}" (use ${OPS.join(', ')})`);
  for (const option of REQUIRED_BY_OP[checked]) {
    if (stringOption(call.values, option) === undefined) throw new UsageError(`memory ${checked} needs --${option}`);
  }
  const text = stringOption(call.values, 'text');
  if (text !== undefined && text.length > LIMITS.memoryTextChars) {
    throw new UsageError(`--text is ${text.length} characters; the limit is ${LIMITS.memoryTextChars}`);
  }
  if (text !== undefined && !SINGLE_LINE_TEXT.test(text)) throw new UsageError('--text must be a single line');
  const refs = listOption(call.values, 'refs');
  if (refs !== undefined && refs.length > LIMITS.memoryRefs) {
    throw new UsageError(`--refs has ${refs.length} items; the limit is ${LIMITS.memoryRefs}`);
  }
  return definedOnly<MemoryRequest>({
    op: checked,
    id: stringOption(call.values, 'id'),
    text,
    kind: enumOption(call.values, 'kind', KINDS),
    // Origin records the last writer. Notes written from the shell are the user's unless
    // --origin says otherwise; reads and deletes carry no origin.
    origin: enumOption(call.values, 'origin', ORIGINS) ?? (checked === 'add' || checked === 'update' ? 'user' : undefined),
    refs,
    query: stringOption(call.values, 'query'),
    limit: integerOption(call.values, 'limit', LIMITS.memoryLimit),
  });
}

export const memoryCommand: CommandSpec = {
  name: 'memory',
  summary: 'Notes anchored to code, with provenance and staleness (maxify_memory).',
  usage: 'memory <add|search|list|get|update|delete> [--id ID] [--text T] [--kind K] [--origin O] [--refs a,b] [--query Q] [--limit N]',
  details: ['add needs --text; search needs --query; get, update and delete need --id.'],
  options: {
    id: { type: 'string' },
    text: { type: 'string' },
    kind: { type: 'string' },
    origin: { type: 'string' },
    refs: { type: 'string', multiple: true },
    query: { type: 'string' },
    limit: { type: 'string' },
  },
  optionDocs: [
    { flag: '--id ID', description: 'Note id.' },
    { flag: '--text T', description: `Note text: one line, at most ${LIMITS.memoryTextChars} characters.` },
    { flag: '--kind K', description: `Note type: ${KINDS.join(', ')}.` },
    { flag: '--origin O', description: `Who wrote it: ${ORIGINS.join(', ')}. Default for add and update: user.` },
    { flag: '--refs a,b', description: 'Paths or path#Symbol the note is about (staleness is tracked against them).' },
    { flag: '--query Q', description: 'Search text.' },
    { flag: '--limit N', description: `Maximum number of notes (${LIMITS.memoryLimit.min}-${LIMITS.memoryLimit.max}).` },
  ],
  async run(call) {
    const request = buildRequest(call);
    return withEngine(call, undefined, async (engine) => printToolOutput(call, await engine.memory(request)));
  },
};
