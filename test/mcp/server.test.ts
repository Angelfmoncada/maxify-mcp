import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MaxifyError } from '../../src/core/errors.js';
import { MAX_BUDGET, MAX_RESULT_CHARS, MIN_BUDGET } from '../../src/engine/types.js';
import { MAX_TASK_CHARS } from '../../src/engine/validate.js';
import { buildInstructions } from '../../src/mcp/instructions.js';
import { ERROR_TEXT_MAX_CHARS, INTERNAL_ERROR_TEXT } from '../../src/mcp/results.js';
import { TOOL_NAMES } from '../../src/mcp/tools.js';
import { callText, connect, createFakeEngine, okOutput, type Connected } from './helpers.js';

function wordCount(text: string): number {
  return text.split(/\s+/).filter((word) => word.length > 0).length;
}

function propertyDescriptions(tool: Tool): Array<{ name: string; description: string | undefined }> {
  const properties = (tool.inputSchema.properties ?? {}) as Record<string, { description?: string }>;
  return Object.entries(properties).map(([name, schema]) => ({ name, description: schema.description }));
}

describe('tool surface', () => {
  let session: Connected;
  let tools: Tool[];

  beforeEach(async () => {
    session = await connect(createFakeEngine().engine);
    tools = (await session.client.listTools()).tools;
  });
  afterEach(async () => {
    await session.close();
  });

  it('exposes exactly the six tools', () => {
    expect(tools.map((tool) => tool.name).sort()).toEqual([...TOOL_NAMES].sort());
    expect(tools).toHaveLength(6);
  });

  it('keeps tool descriptions under 55 words and parameter descriptions under 15', () => {
    for (const tool of tools) {
      expect(wordCount(tool.description ?? ''), tool.name).toBeGreaterThan(0);
      expect(wordCount(tool.description ?? ''), tool.name).toBeLessThanOrEqual(55);
      for (const { name, description } of propertyDescriptions(tool)) {
        expect(description, `${tool.name}.${name}`).toBeTruthy();
        expect(wordCount(description ?? ''), `${tool.name}.${name}`).toBeLessThanOrEqual(15);
      }
    }
  });

  it('sets annotations: openWorldHint false everywhere, readOnly for the four read tools', () => {
    for (const tool of tools) expect(tool.annotations?.openWorldHint, tool.name).toBe(false);
    for (const name of ['maxify_context', 'maxify_source', 'maxify_impact', 'maxify_stats']) {
      expect(tools.find((tool) => tool.name === name)?.annotations?.readOnlyHint, name).toBe(true);
    }
    const compress = tools.find((tool) => tool.name === 'maxify_compress')?.annotations;
    expect(compress).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    const memory = tools.find((tool) => tool.name === 'maxify_memory')?.annotations;
    expect(memory).toMatchObject({ readOnlyHint: false, destructiveHint: true });
  });

  it('asks clients to always load only maxify_context and maxify_source', () => {
    const loaded = tools.filter((tool) => tool._meta?.['anthropic/alwaysLoad'] === true).map((tool) => tool.name);
    expect(loaded.sort()).toEqual(['maxify_context', 'maxify_source']);
  });

  it('declares no output schema (structured content would duplicate tokens)', () => {
    for (const tool of tools) expect(tool.outputSchema, tool.name).toBeUndefined();
  });

  it('uses the shared budget bounds and requires the documented parameters', () => {
    const context = tools.find((tool) => tool.name === 'maxify_context');
    const budget = (context?.inputSchema.properties as Record<string, { minimum?: number; maximum?: number }>).budget;
    expect(budget).toMatchObject({ minimum: MIN_BUDGET, maximum: MAX_BUDGET });
    expect(context?.inputSchema.required).toEqual(['task']);
    expect(tools.find((tool) => tool.name === 'maxify_source')?.inputSchema.required).toEqual(['ref']);
    expect(tools.find((tool) => tool.name === 'maxify_impact')?.inputSchema.required).toEqual(['targets']);
    expect(tools.find((tool) => tool.name === 'maxify_memory')?.inputSchema.required).toEqual(['op']);
    expect(tools.find((tool) => tool.name === 'maxify_compress')?.inputSchema.required).toBeUndefined();
  });

  it('reports server name, version and instructions', () => {
    expect(session.client.getServerVersion()).toMatchObject({ name: 'maxify', version: '1.2.3' });
    expect(session.client.getInstructions()).toBe(buildInstructions('maxify'));
  });
});

describe('argument mapping (snake_case -> camelCase)', () => {
  let session: Connected;
  let fake: ReturnType<typeof createFakeEngine>;

  beforeEach(async () => {
    fake = createFakeEngine();
    session = await connect(fake.engine);
  });
  afterEach(async () => {
    await session.close();
  });

  it('maxify_context', async () => {
    const result = await callText(session.client, 'maxify_context', {
      task: 'fix login',
      budget: 2000,
      focus: ['src/auth.ts'],
      detail: 'signature',
      include_tests: false,
      cursor: 'c1',
      delta: true,
    });
    expect(result).toMatchObject({ text: 'context ok', isError: false });
    expect(fake.calls).toEqual([
      {
        method: 'context',
        request: {
          task: 'fix login',
          budget: 2000,
          focus: ['src/auth.ts'],
          detail: 'signature',
          includeTests: false,
          cursor: 'c1',
          delta: true,
        },
      },
    ]);
  });

  it('only forwards the keys the caller sent', async () => {
    await callText(session.client, 'maxify_context', { task: 'just the task' });
    expect(fake.calls[0]?.request).toStrictEqual({ task: 'just the task' });
  });

  it('maxify_source', async () => {
    await callText(session.client, 'maxify_source', { ref: 'src/a.ts#A.b', context_lines: 3, max_tokens: 900 });
    expect(fake.calls[0]).toEqual({
      method: 'source',
      request: { ref: 'src/a.ts#A.b', contextLines: 3, maxTokens: 900 },
    });
  });

  it('maxify_impact', async () => {
    await callText(session.client, 'maxify_impact', { targets: ['a.ts', 'b.ts#B'], depth: 3, budget: 1500 });
    expect(fake.calls[0]).toEqual({
      method: 'impact',
      request: { targets: ['a.ts', 'b.ts#B'], depth: 3, budget: 1500 },
    });
  });

  it('maxify_compress', async () => {
    await callText(session.client, 'maxify_compress', {
      path: 'out.log',
      kind: 'test',
      max_tokens: 800,
      focus: ['FAIL'],
    });
    await callText(session.client, 'maxify_compress', { ref: 'blob:abc', lines: '10-20', text: 'raw' });
    expect(fake.calls[0]).toEqual({
      method: 'compress',
      request: { path: 'out.log', kind: 'test', maxTokens: 800, focus: ['FAIL'] },
    });
    expect(fake.calls[1]).toEqual({
      method: 'compress',
      request: { ref: 'blob:abc', lines: '10-20', text: 'raw' },
    });
  });

  it('maxify_memory assigns provenance itself: notes written through MCP are agent-authored', async () => {
    await callText(session.client, 'maxify_memory', { op: 'add', text: 'uses jose', kind: 'fact', refs: ['src/a.ts'] });
    // A model cannot claim user authorship: the parameter does not exist and is dropped.
    await callText(session.client, 'maxify_memory', { op: 'add', text: 'user said so', origin: 'user' });
    await callText(session.client, 'maxify_memory', { op: 'update', id: 'n1', text: 'rewritten', origin: 'user' });
    await callText(session.client, 'maxify_memory', { op: 'search', query: 'jose', limit: 5 });
    await callText(session.client, 'maxify_memory', { op: 'list', origin: 'user' });
    await callText(session.client, 'maxify_memory', { op: 'get', id: 'n1' });
    await callText(session.client, 'maxify_memory', { op: 'delete', id: 'n1' });
    const requests = fake.calls.map((call) => call.request);
    expect(requests[0]).toStrictEqual({ op: 'add', text: 'uses jose', kind: 'fact', origin: 'agent', refs: ['src/a.ts'] });
    expect(requests[1]).toStrictEqual({ op: 'add', text: 'user said so', origin: 'agent' });
    expect(requests[2]).toStrictEqual({ op: 'update', id: 'n1', text: 'rewritten', origin: 'agent' });
    expect(requests[3]).toStrictEqual({ op: 'search', query: 'jose', limit: 5 });
    expect(requests[4]).toStrictEqual({ op: 'list' });
    expect(requests[5]).toStrictEqual({ op: 'get', id: 'n1' });
    expect(requests[6]).toStrictEqual({ op: 'delete', id: 'n1' });
  });

  it('maxify_stats', async () => {
    await callText(session.client, 'maxify_stats', { scope: 'session' });
    await callText(session.client, 'maxify_stats', {});
    expect(fake.calls[0]).toEqual({ method: 'stats', request: { scope: 'session' } });
    expect(fake.calls[1]).toStrictEqual({ method: 'stats', request: {} });
  });
});

describe('input validation', () => {
  let session: Connected;
  let fake: ReturnType<typeof createFakeEngine>;

  beforeEach(async () => {
    fake = createFakeEngine();
    session = await connect(fake.engine);
  });
  afterEach(async () => {
    await session.close();
  });

  const invalid: Array<[string, string, Record<string, unknown>]> = [
    ['missing required task', 'maxify_context', {}],
    ['empty task', 'maxify_context', { task: '' }],
    ['budget below minimum', 'maxify_context', { task: 'x', budget: MIN_BUDGET - 1 }],
    ['budget above maximum', 'maxify_context', { task: 'x', budget: MAX_BUDGET + 1 }],
    ['non-integer budget', 'maxify_context', { task: 'x', budget: 1000.5 }],
    ['unknown detail', 'maxify_context', { task: 'x', detail: 'everything' }],
    ['focus not an array', 'maxify_context', { task: 'x', focus: 'src' }],
    ['context_lines above 50', 'maxify_source', { ref: 'a.ts', context_lines: 51 }],
    ['negative context_lines', 'maxify_source', { ref: 'a.ts', context_lines: -1 }],
    ['source without ref', 'maxify_source', {}],
    ['empty targets', 'maxify_impact', { targets: [] }],
    ['21 targets', 'maxify_impact', { targets: Array.from({ length: 21 }, (_, i) => `f${i}.ts`) }],
    ['depth above 5', 'maxify_impact', { targets: ['a.ts'], depth: 6 }],
    ['depth zero', 'maxify_impact', { targets: ['a.ts'], depth: 0 }],
    ['unknown compress kind', 'maxify_compress', { text: 'x', kind: 'yaml' }],
    ['malformed lines', 'maxify_compress', { ref: 'blob:a', lines: 'ten-twenty' }],
    ['unknown memory op', 'maxify_memory', { op: 'purge' }],
    ['memory note over 1000 chars', 'maxify_memory', { op: 'add', text: 'x'.repeat(1001) }],
    ['unknown memory kind', 'maxify_memory', { op: 'add', text: 'x', kind: 'rumor' }],
    ['unknown stats scope', 'maxify_stats', { scope: 'planet' }],
    ['task longer than the engine accepts', 'maxify_context', { task: 'x'.repeat(MAX_TASK_CHARS + 1) }],
    ['21 focus entries', 'maxify_context', { task: 'x', focus: Array.from({ length: 21 }, (_, i) => `f${i}`) }],
    ['empty focus entry', 'maxify_context', { task: 'x', focus: [''] }],
    ['page size below the engine minimum', 'maxify_source', { ref: 'a.ts', max_tokens: MIN_BUDGET - 1 }],
    ['compress focus term over 200 chars', 'maxify_compress', { text: 'x', focus: ['y'.repeat(201)] }],
    ['inline text over the frame-safe limit', 'maxify_compress', { text: 'x'.repeat(1_000_001) }],
    ['memory listing over 50', 'maxify_memory', { op: 'list', limit: 51 }],
    ['11 memory refs', 'maxify_memory', { op: 'add', text: 'x', refs: Array.from({ length: 11 }, (_, i) => `f${i}.ts`) }],
    ['memory note with a newline', 'maxify_memory', { op: 'add', text: 'one\ntwo' }],
    ['memory note with a carriage return', 'maxify_memory', { op: 'update', id: 'n1', text: 'one\rtwo' }],
    ['memory note with an escape character', 'maxify_memory', { op: 'add', text: 'a\u001bb' }],
    ['memory note with a Unicode line separator', 'maxify_memory', { op: 'add', text: `a${String.fromCharCode(0x2028)}b` }],
  ];

  it.each(invalid)('rejects %s with an error result', async (_label, tool, args) => {
    const result = await callText(session.client, tool, args);
    expect(result.isError).toBe(true);
    expect(result.text).toContain(tool);
    expect(fake.calls).toHaveLength(0);
  });

  it('accepts the boundary values', async () => {
    const calls: Array<[string, Record<string, unknown>]> = [
      ['maxify_context', { task: 'x', budget: MIN_BUDGET }],
      ['maxify_context', { task: 'x', budget: MAX_BUDGET }],
      ['maxify_source', { ref: 'a.ts', context_lines: 0 }],
      ['maxify_source', { ref: 'a.ts', context_lines: 50 }],
      ['maxify_impact', { targets: Array.from({ length: 20 }, (_, i) => `f${i}.ts`), depth: 5 }],
      ['maxify_memory', { op: 'add', text: 'x'.repeat(1000) }],
      ['maxify_compress', { ref: 'blob:a', lines: '5' }],
      ['maxify_compress', { text: 'x'.repeat(1_000_000), focus: ['y'.repeat(200)] }],
      ['maxify_context', { task: 'x'.repeat(MAX_TASK_CHARS), focus: Array.from({ length: 20 }, (_, i) => `f${i}`) }],
      ['maxify_source', { ref: 'a.ts', max_tokens: MIN_BUDGET }],
      ['maxify_memory', { op: 'add', text: 'a tab\tis fine', refs: Array.from({ length: 10 }, (_, i) => `f${i}.ts`) }],
      ['maxify_memory', { op: 'list', limit: 50 }],
    ];
    for (const [tool, args] of calls) {
      const result = await callText(session.client, tool, args);
      expect(result.isError, `${tool} ${JSON.stringify(args).slice(0, 60)}`).toBe(false);
    }
  });

  it('reports an unknown tool as an error', async () => {
    const result = await callText(session.client, 'maxify_nope', {});
    expect(result.isError).toBe(true);
    expect(result.text).toContain('maxify_nope');
  });
});

describe('result and error mapping', () => {
  let session: Connected | undefined;
  afterEach(async () => {
    vi.restoreAllMocks();
    await session?.close();
    session = undefined;
  });

  it('returns only content (and isError on failure), never structuredContent', async () => {
    const { engine } = createFakeEngine({
      context: async () => okOutput('ok', { meta: { estTokens: 3, complete: true, durationMs: 1, items: [] } }),
      source: async () => okOutput('bad ref', { isError: true }),
    });
    session = await connect(engine);
    const ok = await callText(session.client, 'maxify_context', { task: 'x' });
    expect(ok).toMatchObject({ text: 'ok', isError: false, keys: ['content'], contentTypes: ['text'] });
    const failed = await callText(session.client, 'maxify_source', { ref: 'nope' });
    expect(failed).toMatchObject({ text: 'bad ref', isError: true, keys: ['content', 'isError'], contentTypes: ['text'] });
  });

  it('maps MaxifyError to an error result carrying its message', async () => {
    const { engine } = createFakeEngine({
      source: async () => {
        throw new MaxifyError('NOT_FOUND', 'No such file "src/zzz.ts". Try maxify_context to find it.');
      },
    });
    session = await connect(engine);
    const result = await callText(session.client, 'maxify_source', { ref: 'src/zzz.ts' });
    expect(result).toMatchObject({ isError: true, text: 'No such file "src/zzz.ts". Try maxify_context to find it.' });
  });

  it('maps unexpected errors to a generic error and logs the stack to stderr', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const { engine } = createFakeEngine({
      impact: async () => {
        throw new TypeError('database exploded at C:\\secret\\path');
      },
    });
    session = await connect(engine);
    const result = await callText(session.client, 'maxify_impact', { targets: ['a.ts'] });
    expect(result).toMatchObject({ isError: true, text: INTERNAL_ERROR_TEXT });
    expect(result.text).not.toContain('secret');
    const logged = stderr.mock.calls.map((call) => String(call[0])).join('');
    expect(logged).toContain('database exploded');
    expect(logged).toContain('maxify_impact');
  });

  it('handles non-Error throws and synchronous throws', async () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const { engine } = createFakeEngine({
      stats: () => {
        throw 'plain string';
      },
    });
    session = await connect(engine);
    const result = await callText(session.client, 'maxify_stats', {});
    expect(result).toMatchObject({ isError: true, text: INTERNAL_ERROR_TEXT });
  });

  it('logs INTERNAL MaxifyErrors but still returns their message', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const { engine } = createFakeEngine({
      memory: async () => {
        throw new MaxifyError('INTERNAL', 'store is locked; retry');
      },
    });
    session = await connect(engine);
    const result = await callText(session.client, 'maxify_memory', { op: 'list' });
    expect(result).toMatchObject({ isError: true, text: 'store is locked; retry' });
    expect(stderr.mock.calls.map((call) => String(call[0])).join('')).toContain('store is locked');
  });

  it('keeps error text short', async () => {
    const { engine } = createFakeEngine({
      source: async () => {
        throw new MaxifyError('AMBIGUOUS', 'candidate\n'.repeat(5000));
      },
    });
    session = await connect(engine);
    const result = await callText(session.client, 'maxify_source', { ref: 'Name' });
    expect(result.isError).toBe(true);
    expect(result.text.length).toBeLessThan(ERROR_TEXT_MAX_CHARS + 200);
    expect(result.text).toContain('characters omitted here (error text limit 4000)');
  });

  it('caps oversized results explicitly instead of letting the client spill them to a file', async () => {
    const { engine } = createFakeEngine({
      context: async () => okOutput('line of evidence\n'.repeat(5000)),
    });
    session = await connect(engine);
    const result = await callText(session.client, 'maxify_context', { task: 'big' });
    expect(result.isError).toBe(false);
    expect(result.text.length).toBeLessThan(MAX_RESULT_CHARS + 200);
    expect(result.text).toContain(`characters omitted here (result limit ${MAX_RESULT_CHARS})`);
  });

  it('keeps the footer when it cuts: continuation pointers live at the end of a result', async () => {
    const footer = 'continues: src/big.ts:900-1400 (ask maxify_source with that ref)';
    const { engine } = createFakeEngine({
      source: async () => okOutput(`${'code line\n'.repeat(8000)}${footer}\n`),
    });
    session = await connect(engine);
    const result = await callText(session.client, 'maxify_source', { ref: 'src/big.ts' });
    expect(result.text.startsWith('code line\ncode line\n')).toBe(true);
    expect(result.text).toContain(footer);
    expect(result.text.endsWith(`${footer}\n`)).toBe(true);
    expect(result.text.indexOf('characters omitted here')).toBeGreaterThan(0);
  });

  it('cuts on line boundaries when it can', async () => {
    const { engine } = createFakeEngine({
      context: async () => okOutput(Array.from({ length: 6000 }, (_, i) => `row ${i}`).join('\n')),
    });
    session = await connect(engine);
    const { text } = await callText(session.client, 'maxify_context', { task: 'rows' });
    const [before = '', after = ''] = text.split(/\n\[maxify: \d+ characters omitted here[^\n]*\]\n/);
    expect(before).toMatch(/\nrow \d+$/);
    expect(after).toMatch(/^row \d+\n/);
  });

  it('never splits a surrogate pair at either cut point', async () => {
    const emoji = '\u{1F600}';
    const lone = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
    // The head would end between the two halves of the pair...
    const atHead = `${'a'.repeat(MAX_RESULT_CHARS - 1500 - 1)}${emoji}${'b'.repeat(20_000)}`;
    // ...and here the tail would start between them.
    const atTail = `${'a'.repeat(50_000)}${emoji}${'b'.repeat(1499)}`;
    for (const text of [atHead, atTail]) {
      const { engine } = createFakeEngine({ context: async () => okOutput(text) });
      const connected = await connect(engine);
      try {
        const result = await callText(connected.client, 'maxify_context', { task: 'emoji' });
        expect(result.text, text.slice(0, 5)).not.toMatch(lone);
        expect(result.text).toContain('characters omitted here');
      } finally {
        await connected.close();
      }
    }
  });

  it('replaces empty output with a placeholder (empty text blocks are rejected by some clients)', async () => {
    const { engine } = createFakeEngine({ stats: async () => okOutput('   ') });
    session = await connect(engine);
    const result = await callText(session.client, 'maxify_stats', {});
    expect(result).toMatchObject({ text: '(no output)', isError: false });
  });
});
