import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { okOutput } from '../mcp/helpers.js';
import { createHarness, createTempProject, type Harness, type TempProject } from './helpers.js';

const LOG = 'INFO start\nERROR boom\nINFO end\n';

describe('maxify compress', () => {
  let project: TempProject;
  beforeEach(() => {
    project = createTempProject();
  });
  afterEach(() => {
    project.cleanup();
  });

  const harness = (options: Parameters<typeof createHarness>[0] = {}): Harness =>
    createHarness({ cwd: project.dir, ...options });

  describe('from stdin', () => {
    it('reads piped input, passes it as text and prints only the compressed text on stdout', async () => {
      const h = harness({
        stdin: LOG,
        engine: { compress: async () => okOutput('ERROR boom (line 2)') },
      });
      const code = await h.run('compress');
      expect(code).toBe(0);
      expect(h.stdout()).toBe('ERROR boom (line 2)\n');
      expect(h.stderr()).toBe('');
    });

    it('sends the stdin text and the options to the engine', async () => {
      const h = harness({ stdin: LOG });
      await h.run('compress', '--kind', 'log', '--max-tokens', '800', '--focus', 'ERROR,WARN');
      expect(h.fake.calls).toEqual([
        { method: 'compress', request: { text: LOG, kind: 'log', maxTokens: 800, focus: ['ERROR', 'WARN'] } },
      ]);
    });

    it('does not index and opens the engine for compression only', async () => {
      const h = harness({ stdin: LOG });
      await h.run('compress');
      expect(h.opened).toHaveLength(1);
      expect(h.opened[0]).toMatchObject({ root: project.dir, autoIndex: false });
    });

    it('treats empty stdin as nothing to compress, not as a failure', async () => {
      const h = harness({ stdin: '' });
      const code = await h.run('compress');
      expect(code).toBe(0);
      expect(h.stdout()).toBe('');
      expect(h.stderr()).toContain('nothing to compress');
      expect(h.fake.calls).toHaveLength(0);
      expect(h.opened).toHaveLength(0);
    });

    it('stays silent about empty input with --quiet', async () => {
      const h = harness({ stdin: '' });
      await h.run('compress', '--quiet');
      expect(h.stderr()).toBe('');
    });

    it('prints an empty JSON result for empty stdin with --json', async () => {
      const h = harness({ stdin: '' });
      expect(await h.run('compress', '--json', '-q')).toBe(0);
      expect(JSON.parse(h.stdout())).toEqual({ text: '', meta: { empty: true } });
    });

    it('is a usage error when stdin is a terminal and nothing else was given', async () => {
      const h = harness({ stdinIsTTY: true });
      const code = await h.run('compress');
      expect(code).toBe(2);
      expect(h.stderr()).toContain('compress needs a file, piped stdin');
      expect(h.stderr()).toContain('maxify compress --help');
      expect(h.stdout()).toBe('');
    });
  });

  describe('from a file', () => {
    it('reads the file itself and passes its text', async () => {
      writeFileSync(path.join(project.dir, 'build.log'), LOG);
      const h = harness({ stdin: 'IGNORED', stdinIsTTY: true });
      const code = await h.run('compress', 'build.log');
      expect(code).toBe(0);
      expect(h.fake.calls[0]).toEqual({ method: 'compress', request: { text: LOG } });
      expect(h.stdout()).toBe('compress ok\n');
    });

    it('resolves relative paths against the working directory and accepts absolute ones', async () => {
      writeFileSync(path.join(project.dir, 'a.log'), 'first');
      writeFileSync(path.join(project.dir, 'b.log'), 'second');
      const h = harness();
      await h.run('compress', 'a.log');
      await h.run('compress', path.join(project.dir, 'b.log'));
      expect(h.fake.calls.map((call) => (call.request as { text: string }).text)).toEqual(['first', 'second']);
    });

    it('strips a UTF-8 BOM', async () => {
      writeFileSync(path.join(project.dir, 'bom.log'), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('x')]));
      const h = harness();
      await h.run('compress', 'bom.log');
      expect((h.fake.calls[0]?.request as { text: string }).text).toBe('x');
    });

    it('reports a missing file with exit code 1 and no stdout', async () => {
      const h = harness();
      const code = await h.run('compress', 'nope.log');
      expect(code).toBe(1);
      expect(h.stderr()).toContain('nope.log');
      expect(h.stdout()).toBe('');
      expect(h.fake.calls).toHaveLength(0);
    });

    it('rejects more than one file', async () => {
      const h = harness();
      expect(await h.run('compress', 'a.log', 'b.log')).toBe(2);
    });
  });

  describe('--ref', () => {
    it('fetches the original lines without reading stdin or files', async () => {
      const h = harness({ stdin: 'SHOULD NOT BE READ' });
      const code = await h.run('compress', '--ref', 'blob:abc123', '--lines', '10-20');
      expect(code).toBe(0);
      expect(h.fake.calls[0]).toEqual({ method: 'compress', request: { ref: 'blob:abc123', lines: '10-20' } });
    });

    it('works without --lines', async () => {
      const h = harness();
      await h.run('compress', '--ref', 'abc123');
      expect(h.fake.calls[0]?.request).toEqual({ ref: 'abc123' });
    });

    it('refuses to combine --ref with a file', async () => {
      const h = harness();
      expect(await h.run('compress', 'a.log', '--ref', 'abc')).toBe(2);
      expect(h.stderr()).toContain('either a file or --ref');
    });

    it('needs --ref for --lines', async () => {
      const h = harness({ stdin: LOG });
      expect(await h.run('compress', '--lines', '1-2')).toBe(2);
      expect(h.stderr()).toContain('--lines needs --ref');
    });

    it.each(['abc', '1-', '-5', '1-2-3', '0x10'])('rejects --lines %j', async (lines) => {
      const h = harness();
      expect(await h.run('compress', '--ref', 'abc', `--lines=${lines}`)).toBe(2);
      expect(h.stderr()).toContain('--lines must look like START-END');
    });
  });

  describe('options and output modes', () => {
    it('rejects an unknown --kind and an out-of-range --max-tokens', async () => {
      const h = harness({ stdin: LOG });
      expect(await h.run('compress', '--kind', 'yaml')).toBe(2);
      expect(await h.run('compress', '--max-tokens', '5')).toBe(2);
    });

    it('prints {text, meta} with --json', async () => {
      const h = harness({
        stdin: LOG,
        engine: { compress: async () => okOutput('short', { meta: { estTokens: 2, complete: true, durationMs: 1, cacheHit: false } }) },
      });
      expect(await h.run('compress', '--json')).toBe(0);
      expect(JSON.parse(h.stdout())).toEqual({
        text: 'short',
        meta: { estTokens: 2, complete: true, durationMs: 1, cacheHit: false },
      });
    });

    it('sends an engine-reported error to stderr and exits 1', async () => {
      const h = harness({
        stdin: LOG,
        engine: { compress: async () => okOutput('unknown blob ref', { isError: true }) },
      });
      expect(await h.run('compress')).toBe(1);
      expect(h.stderr()).toBe('unknown blob ref\n');
      expect(h.stdout()).toBe('');
    });

    it('keeps errors on stderr as plain text even with --json (stdout carries JSON only on success)', async () => {
      const h = harness({
        stdin: LOG,
        engine: { compress: async () => okOutput('bad', { isError: true }) },
      });
      expect(await h.run('compress', '--json')).toBe(1);
      expect(h.stdout()).toBe('');
      expect(h.stderr()).toBe('bad\n');
    });

    it('closes the engine after use, even when compression fails', async () => {
      const h = harness({
        stdin: LOG,
        engine: {
          compress: async () => {
            throw new Error('disk full');
          },
        },
      });
      expect(await h.run('compress')).toBe(1);
      expect(h.stderr()).toContain('disk full');
      expect(h.fake.engine.close).toHaveBeenCalledTimes(1);
    });
  });
});
