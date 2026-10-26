import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AGENT_BENCH_NOTICE } from '../../src/cli/commands/bench.js';
import { formatIndexSummary } from '../../src/cli/commands/indexCmd.js';
import { EMPTY_SUMMARY, okOutput } from '../mcp/helpers.js';
import { createHarness, createTempProject, type Harness, type TempProject } from './helpers.js';

describe('engine-backed commands', () => {
  let project: TempProject;
  beforeEach(() => {
    project = createTempProject();
  });
  afterEach(() => {
    project.cleanup();
  });

  const harness = (options: Parameters<typeof createHarness>[0] = {}): Harness =>
    createHarness({ cwd: project.dir, ...options });

  describe('query', () => {
    it('maps arguments to a context request and prints the text', async () => {
      const h = harness();
      expect(
        await h.run('query', 'fix', 'the', 'login', '--budget', '2000', '--focus', 'src/auth.ts,Session', '--detail', 'signature', '--no-tests', '--cursor', 'c9'),
      ).toBe(0);
      expect(h.fake.calls).toEqual([
        {
          method: 'context',
          request: {
            task: 'fix the login',
            budget: 2000,
            focus: ['src/auth.ts', 'Session'],
            detail: 'signature',
            includeTests: false,
            cursor: 'c9',
          },
        },
      ]);
      expect(h.stdout()).toBe('context ok\n');
    });

    it('sends only the task when nothing else is given, and lets the engine index on open', async () => {
      const h = harness();
      await h.run('query', 'just this');
      expect(h.fake.calls[0]?.request).toStrictEqual({ task: 'just this' });
      expect(h.opened[0]).toStrictEqual({ root: project.dir });
    });

    it('prints {text, meta} with --json', async () => {
      const h = harness();
      await h.run('query', 'x', '--json');
      expect(JSON.parse(h.stdout())).toEqual({
        text: 'context ok',
        meta: { estTokens: 1, complete: true, durationMs: 0 },
      });
    });

    it.each([
      [['--budget', '299']],
      [['--budget', '12001']],
      [['--budget', 'lots']],
      [['--detail', 'everything']],
    ])('rejects %j', async (extra) => {
      const h = harness();
      expect(await h.run('query', 'x', ...extra)).toBe(2);
      expect(h.fake.calls).toHaveLength(0);
    });

    it('treats an engine error result as a failure', async () => {
      const h = harness({ engine: { context: async () => okOutput('cursor expired', { isError: true }) } });
      expect(await h.run('query', 'x', '--cursor', 'old')).toBe(1);
      expect(h.stderr()).toBe('cursor expired\n');
    });
  });

  describe('source', () => {
    it('maps the ref and numeric options', async () => {
      const h = harness();
      expect(await h.run('source', 'src/a.ts#A.b', '--context-lines', '4', '--max-tokens', '900')).toBe(0);
      expect(h.fake.calls[0]).toEqual({
        method: 'source',
        request: { ref: 'src/a.ts#A.b', contextLines: 4, maxTokens: 900 },
      });
      expect(h.stdout()).toBe('source ok\n');
    });

    it('needs exactly one ref', async () => {
      const h = harness();
      expect(await h.run('source')).toBe(2);
      expect(await h.run('source', 'a.ts', 'b.ts')).toBe(2);
    });

    it('validates --context-lines and --max-tokens', async () => {
      const h = harness();
      expect(await h.run('source', 'a.ts', '--context-lines', '51')).toBe(2);
      expect(await h.run('source', 'a.ts', '--max-tokens', '99')).toBe(2);
    });
  });

  describe('impact', () => {
    it('maps targets, depth and budget', async () => {
      const h = harness();
      expect(await h.run('impact', 'src/a.ts', 'src/b.ts#B', '--depth', '3', '--budget', '1500')).toBe(0);
      expect(h.fake.calls[0]).toEqual({
        method: 'impact',
        request: { targets: ['src/a.ts', 'src/b.ts#B'], depth: 3, budget: 1500 },
      });
    });

    it('needs 1 to 20 targets and a depth from 1 to 5', async () => {
      const h = harness();
      expect(await h.run('impact')).toBe(2);
      expect(await h.run('impact', ...Array.from({ length: 21 }, (_, i) => `f${i}.ts`))).toBe(2);
      expect(await h.run('impact', ...Array.from({ length: 20 }, (_, i) => `f${i}.ts`))).toBe(0);
      expect(await h.run('impact', 'a.ts', '--depth', '6')).toBe(2);
      expect(await h.run('impact', 'a.ts', '--depth', '0')).toBe(2);
    });
  });

  describe('memory', () => {
    it('adds a note attributed to the user by default', async () => {
      const h = harness();
      expect(await h.run('memory', 'add', '--text', 'uses jose', '--kind', 'decision', '--refs', 'src/a.ts,src/b.ts#B')).toBe(0);
      expect(h.fake.calls[0]).toEqual({
        method: 'memory',
        request: { op: 'add', text: 'uses jose', kind: 'decision', origin: 'user', refs: ['src/a.ts', 'src/b.ts#B'] },
      });
    });

    it('honours --origin agent', async () => {
      const h = harness();
      await h.run('memory', 'add', '--text', 'x', '--origin', 'agent');
      expect((h.fake.calls[0]?.request as { origin: string }).origin).toBe('agent');
    });

    it('does not add an implicit origin to other operations (it could act as a filter)', async () => {
      const h = harness();
      await h.run('memory', 'list', '--limit', '10');
      await h.run('memory', 'search', '--query', 'jose');
      await h.run('memory', 'get', '--id', 'n1');
      await h.run('memory', 'delete', '--id', 'n1');
      await h.run('memory', 'update', '--id', 'n1', '--text', 'new text');
      const requests = h.fake.calls.map((call) => call.request);
      expect(requests[0]).toStrictEqual({ op: 'list', limit: 10 });
      expect(requests[1]).toStrictEqual({ op: 'search', query: 'jose' });
      expect(requests[2]).toStrictEqual({ op: 'get', id: 'n1' });
      expect(requests[3]).toStrictEqual({ op: 'delete', id: 'n1' });
      expect(requests[4]).toStrictEqual({ op: 'update', id: 'n1', text: 'new text' });
    });

    it.each([
      [['add'], '--text'],
      [['search'], '--query'],
      [['get'], '--id'],
      [['update'], '--id'],
      [['delete'], '--id'],
    ])('%j fails with a usage error naming %s', async (argv, option) => {
      const h = harness();
      expect(await h.run('memory', ...argv)).toBe(2);
      expect(h.stderr()).toContain(`needs ${option}`);
      expect(h.fake.calls).toHaveLength(0);
    });

    it('validates the operation, the note size and the list sizes', async () => {
      const h = harness();
      expect(await h.run('memory')).toBe(2);
      expect(await h.run('memory', 'purge')).toBe(2);
      expect(await h.run('memory', 'add', '--text', 'x'.repeat(1001))).toBe(2);
      expect(await h.run('memory', 'add', '--text', 'x'.repeat(1000))).toBe(0);
      expect(await h.run('memory', 'add', '--text', 'x', '--refs', Array.from({ length: 21 }, (_, i) => `f${i}`).join(','))).toBe(2);
      expect(await h.run('memory', 'list', '--limit', '0')).toBe(2);
      expect(await h.run('memory', 'add', '--text', 'x', '--kind', 'rumor')).toBe(2);
      expect(await h.run('memory', 'add', '--text', 'x', '--origin', 'robot')).toBe(2);
    });
  });

  describe('stats', () => {
    it('prints the engine report followed by the tool-surface overhead', async () => {
      const h = harness();
      expect(await h.run('stats', '--scope', 'session')).toBe(0);
      expect(h.fake.calls[0]).toEqual({ method: 'stats', request: { scope: 'session' } });
      expect(h.stdout()).toMatch(/^stats ok\n\ntool surface: ~\d+ est\. tokens/);
      expect(h.stdout()).toContain('maxify_context');
      expect(h.opened[0]).toMatchObject({ autoIndex: false });
    });

    it('exposes the surface in meta for --json', async () => {
      const h = harness();
      await h.run('stats', '--json');
      const payload = JSON.parse(h.stdout()) as { meta: { toolSurface: { totalTokens: number; tools: unknown[] }; estTokens: number } };
      expect(payload.meta.estTokens).toBe(1);
      expect(payload.meta.toolSurface.tools).toHaveLength(6);
      expect(payload.meta.toolSurface.totalTokens).toBeGreaterThan(500);
    });

    it('sends no scope when none is given and rejects bad ones', async () => {
      const h = harness();
      await h.run('stats');
      expect(h.fake.calls[0]?.request).toStrictEqual({});
      expect(await h.run('stats', '--scope', 'planet')).toBe(2);
      expect(await h.run('stats', 'extra')).toBe(2);
    });
  });

  describe('index', () => {
    it('indexes without auto-indexing on open and prints a summary', async () => {
      const h = harness({
        engine: { index: async () => ({ ...EMPTY_SUMMARY, generation: 7, filesScanned: 12, added: 2, updated: 1, durationMs: 40 }) },
      });
      expect(await h.run('index')).toBe(0);
      expect(h.opened[0]).toMatchObject({ autoIndex: false });
      expect(h.stdout()).toContain(`Indexed ${project.dir}`);
      expect(h.stdout()).toContain('generation 7: 12 files scanned (2 added, 1 updated, 0 removed, 0 renamed, 1 unchanged, 0 skipped) in 40 ms');
      expect(h.stderr()).toContain('indexing');
    });

    it('passes --full through', async () => {
      const index = vi.fn(async () => EMPTY_SUMMARY);
      const h = harness({ engine: { index } });
      await h.run('index', '--full');
      expect(index).toHaveBeenCalledWith({ full: true });
      const plain = harness({ engine: { index } });
      await plain.run('index');
      expect(index).toHaveBeenLastCalledWith(undefined);
    });

    it('lists the first problems and counts the rest', () => {
      const errors = Array.from({ length: 12 }, (_, i) => `bad${i}.ts: parse error`);
      const text = formatIndexSummary('/r', { ...EMPTY_SUMMARY, errors });
      expect(text).toContain('12 file(s) had problems:');
      expect(text).toContain('  - bad0.ts: parse error');
      expect(text).toContain('  - bad9.ts: parse error');
      expect(text).not.toContain('bad10.ts');
      expect(text).toContain('... and 2 more');
    });

    it('prints the summary as meta for --json', async () => {
      const h = harness();
      await h.run('index', '--json', '--quiet');
      const payload = JSON.parse(h.stdout()) as { text: string; meta: { generation: number; errors: string[] } };
      expect(payload.meta.generation).toBe(EMPTY_SUMMARY.generation);
      expect(payload.text).toContain('Indexed');
    });
  });

  describe('bench', () => {
    it('runs the offline suite by default and forwards budgets and the report path', async () => {
      const h = harness();
      expect(await h.run('bench', '--budget', '2000,4000', '--out', 'reports/offline.md')).toBe(0);
      expect(h.deps.runOfflineBench).toHaveBeenCalledWith({
        budgets: [2000, 4000],
        out: path.join(project.dir, 'reports', 'offline.md'),
      });
      expect(h.stdout()).toBe('# offline bench report\n');
      expect(h.opened).toHaveLength(0);
    });

    it('runs without options and returns the suite exit code', async () => {
      const h = harness({
        deps: { runOfflineBench: vi.fn(async () => ({ text: 'threshold missed', exitCode: 3 })) },
      });
      expect(await h.run('bench', '--suite', 'offline')).toBe(3);
      expect(h.deps.runOfflineBench).toHaveBeenCalledWith({});
      expect(h.stdout()).toBe('threshold missed\n');
    });

    it('explains the paid agent suite and never executes anything', async () => {
      const h = harness();
      expect(await h.run('bench', '--suite', 'agent')).toBe(0);
      expect(h.stdout()).toBe(`${AGENT_BENCH_NOTICE}\n`);
      expect(h.stdout()).toContain('bench/agent');
      expect(h.deps.runOfflineBench).not.toHaveBeenCalled();
      expect(h.opened).toHaveLength(0);
    });

    it('validates --suite and --budget', async () => {
      const h = harness();
      expect(await h.run('bench', '--suite', 'nightly')).toBe(2);
      expect(await h.run('bench', '--budget', '100')).toBe(2);
      expect(await h.run('bench', '--budget', '2000,abc')).toBe(2);
      expect(h.deps.runOfflineBench).not.toHaveBeenCalled();
    });

    it('prints the report and meta with --json', async () => {
      const h = harness();
      await h.run('bench', '--json', '--budget', '2000');
      expect(JSON.parse(h.stdout())).toEqual({
        text: '# offline bench report',
        meta: { suite: 'offline', exitCode: 0, budgets: [2000] },
      });
    });
  });

  describe('serve', () => {
    it('opens the engine without auto-indexing and serves it, with the index started by serveStdio', async () => {
      const h = harness({ env: { PATH: '' } });
      expect(await h.run('serve')).toBe(0);
      expect(h.opened[0]).toStrictEqual({ root: project.dir, autoIndex: false });
      expect(h.deps.serve).toHaveBeenCalledTimes(1);
      const [engine, options] = vi.mocked(h.deps.serve).mock.calls[0] ?? [];
      expect(engine).toBe(h.fake.engine);
      expect(options).toMatchObject({ version: '1.2.3', index: true });
      expect(options?.cliCommand).toMatch(/^node ".*cli\.js"$/);
      expect(h.stdout()).toBe('');
    });

    it('can skip the background index', async () => {
      const h = harness();
      await h.run('serve', '--no-index');
      expect(vi.mocked(h.deps.serve).mock.calls[0]?.[1]).toMatchObject({ index: false });
    });

    it('follows CLAUDE_PROJECT_DIR when no root is given', async () => {
      const other = createTempProject();
      try {
        const h = harness({ env: { CLAUDE_PROJECT_DIR: other.dir } });
        await h.run('serve');
        expect(h.opened[0]?.root).toBe(other.dir);
      } finally {
        other.cleanup();
      }
    });

    it('closes the engine and fails when the transport cannot start', async () => {
      const h = harness({
        deps: {
          serve: vi.fn(async () => {
            throw new Error('stdin is closed');
          }),
        },
      });
      expect(await h.run('serve')).toBe(1);
      expect(h.stderr()).toContain('stdin is closed');
      expect(h.fake.engine.close).toHaveBeenCalledTimes(1);
    });

    it('rejects stray arguments', async () => {
      const h = harness();
      expect(await h.run('serve', 'now')).toBe(2);
      expect(h.opened).toHaveLength(0);
    });

    it('keeps stdout clean even if the engine prints while starting, and restores console afterwards', async () => {
      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const originalLog = console.log;
      try {
        const h = harness();
        vi.mocked(h.deps.openEngine).mockImplementation(async () => {
          console.log('engine chatter');
          return h.fake.engine;
        });
        expect(await h.run('serve')).toBe(0);
        expect(h.stdout()).toBe('');
        expect(stderr.mock.calls.map((call) => String(call[0])).join('')).toContain('engine chatter');
        expect(console.log).toBe(originalLog);
      } finally {
        stderr.mockRestore();
      }
    });

    it('restores console when the root is unusable', async () => {
      const originalLog = console.log;
      const h = harness();
      expect(await h.run('serve', '--root', path.join(project.dir, 'missing'))).toBe(1);
      expect(console.log).toBe(originalLog);
    });

    it('tells a human who runs it in a terminal how it is meant to be used', async () => {
      const h = harness({ stdinIsTTY: true });
      await h.run('serve');
      expect(h.stderr()).toContain('an MCP client such as Claude Code starts it');
      const piped = harness({ stdinIsTTY: false });
      await piped.run('serve');
      expect(piped.stderr()).toBe('');
    });
  });
});
