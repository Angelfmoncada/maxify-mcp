import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runMcpSelfTest } from '../../src/cli/selfTest.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/fake-mcp-server.mjs', import.meta.url));

const run = (mode: string, timeoutMs = 20_000): ReturnType<typeof runMcpSelfTest> =>
  runMcpSelfTest({ command: process.execPath, args: [FIXTURE, mode], timeoutMs, cwd: path.dirname(FIXTURE) });

describe('runMcpSelfTest (real child process over stdio)', () => {
  it('passes when the server lists six tools and maxify_stats answers', async () => {
    const result = await run('ok');
    expect(result.ok).toBe(true);
    expect(result.message).toBe('6 tools listed, maxify_stats answered');
    expect(result.toolNames).toHaveLength(6);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('fails when a tool is missing and names it', async () => {
    const result = await run('few');
    expect(result.ok).toBe(false);
    expect(result.message).toContain('expected 6 tools, got 5');
    expect(result.message).toContain('maxify_stats');
  });

  it('fails when maxify_stats reports an error', async () => {
    const result = await run('error');
    expect(result.ok).toBe(false);
    expect(result.message).toContain('maxify_stats returned an error: index is locked');
  });

  it('fails with the server stderr when the process dies before answering', async () => {
    const result = await run('crash');
    expect(result.ok).toBe(false);
    expect(result.message).toContain('fixture: cannot open the index');
  });

  it('fails when the command cannot be started', async () => {
    const result = await runMcpSelfTest({ command: path.join(path.dirname(FIXTURE), 'no-such-binary'), args: [], timeoutMs: 5000 });
    expect(result.ok).toBe(false);
    expect(result.message.length).toBeGreaterThan(0);
  });

  it('gives up after the timeout when the server never answers', async () => {
    const started = Date.now();
    const result = await run('hang', 600);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/timed out/i);
    expect(Date.now() - started).toBeLessThan(15_000);
  }, 30_000);
});
