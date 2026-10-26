/**
 * Smoke test of the built binary (dist/cli.js). Skipped until `npm run build`
 * has produced it; the end-to-end test with the real engine lives with the engine.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const CLI = fileURLToPath(new URL('../../dist/cli.js', import.meta.url));
const VERSION = (JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }).version;

function run(...args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', timeout: 30_000 });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe.skipIf(!existsSync(CLI))('dist/cli.js', () => {
  it('starts with a node shebang', () => {
    expect(readFileSync(CLI, 'utf8').startsWith('#!/usr/bin/env node\n')).toBe(true);
  });

  it('--version prints the package version and exits 0', () => {
    expect(run('--version')).toEqual({ status: 0, stdout: `${VERSION}\n`, stderr: '' });
  });

  it('--help lists the commands on stdout without loading node:sqlite (no experimental warning)', () => {
    const result = run('--help');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Commands:');
    expect(result.stdout).toContain('doctor');
    expect(result.stderr).toBe('');
  });

  it('an unknown command exits 2 with the message on stderr', () => {
    const result = run('frobnicate');
    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('unknown command "frobnicate"');
  });

  it('a usage mistake in a command exits 2', () => {
    const result = run('query');
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('missing task');
  });

  it('compress with an empty pipe succeeds quietly', () => {
    const result = spawnSync(process.execPath, [CLI, 'compress', '--quiet'], { input: '', encoding: 'utf8', timeout: 30_000 });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
  });
});
