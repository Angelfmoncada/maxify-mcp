import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cliEntryPath, createDefaultDeps, createProcessIo } from '../../src/cli/deps.js';
import { MAXIFY_VERSION } from '../../src/version.js';

describe('version', () => {
  it('MAXIFY_VERSION matches package.json (they are bumped together)', () => {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string };
    expect(MAXIFY_VERSION).toBe(pkg.version);
  });
});

describe('createDefaultDeps', () => {
  it('wires the real process and loads heavy modules lazily', () => {
    const deps = createDefaultDeps();
    expect(deps.version).toBe(MAXIFY_VERSION);
    expect(deps.cwd).toBe(process.cwd());
    expect(deps.env).toBe(process.env);
    expect(path.basename(deps.cliPath)).toBe('cli.js');
    expect(deps.cliPath).toBe(cliEntryPath());
    for (const fn of [deps.openEngine, deps.serve, deps.runOfflineBench, deps.runMcpSelfTest]) {
      expect(typeof fn).toBe('function');
    }
  });

  it('resolves the MCP self-test implementation on demand', async () => {
    const deps = createDefaultDeps();
    const result = await deps.runMcpSelfTest({ command: process.execPath, args: ['-e', 'process.exit(3)'], timeoutMs: 5000 });
    expect(result.ok).toBe(false);
  });
});

describe('createProcessIo', () => {
  const stdinDescriptor = Object.getOwnPropertyDescriptor(process, 'stdin');
  afterEach(() => {
    vi.restoreAllMocks();
    if (stdinDescriptor) Object.defineProperty(process, 'stdin', stdinDescriptor);
  });

  it('writes command output to stdout and diagnostics to stderr', () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const io = createProcessIo();
    io.out('data\n');
    io.err('diag\n');
    expect(stdout).toHaveBeenCalledWith('data\n');
    expect(stderr).toHaveBeenCalledWith('diag\n');
  });

  it('reads all of stdin as text and reports whether it is a terminal', async () => {
    Object.defineProperty(process, 'stdin', { value: Readable.from([Buffer.from('piped '), Buffer.from('text')]), configurable: true });
    const io = createProcessIo();
    expect(io.stdinIsTTY).toBe(false);
    expect(await io.readStdin()).toBe('piped text');
  });
});
