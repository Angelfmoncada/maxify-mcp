import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compress } from '../../src/compress/index.js';
import { RepoGuard } from '../../src/core/paths.js';
import { openEngine } from '../../src/engine/engine.js';
import type { MaxifyEngine } from '../../src/engine/types.js';
import { MINI_REPO, writeRepo } from './fixture.js';

let root: string;
let stateDir: string;
let engine: MaxifyEngine;
let linked = false;

beforeAll(async () => {
  root = writeRepo({ ...MINI_REPO, '.gitignore': 'logs/\n', 'logs/run.log': 'ERROR boom\n', 'notes/key.txt': `${['-----BEGIN', 'PRIVATE KEY-----'].join(' ')}\nAAAA\n` }, 'maxify-sec-');
  mkdirSync(path.join(root, 'docs'), { recursive: true });
  try {
    symlinkSync(path.join(root, '.env'), path.join(root, 'docs', 'notes.txt'));
    linked = true;
  } catch {
    linked = false; // creating symlinks needs privileges on some Windows setups
  }
  stateDir = `${root}-state`;
  engine = await openEngine({ root, stateDir });
});

afterAll(() => {
  engine.close();
  rmSync(root, { recursive: true, force: true });
  rmSync(stateDir, { recursive: true, force: true });
});

describe('secret and exclusion bypasses', () => {
  it('never serves a secret through an in-repo symlink', async () => {
    if (!linked) return;
    await expect(engine.source({ ref: 'docs/notes.txt' })).rejects.toThrow(/secret/);
    await expect(engine.compress({ path: 'docs/notes.txt' })).rejects.toThrow(/secret/);
    const stats = await engine.stats({ scope: 'index' });
    expect(stats.text).not.toContain('do-not-read');
  });

  it('refuses ignored files in maxify_compress and points to the CLI pipe', async () => {
    await expect(engine.compress({ path: 'logs/run.log' })).rejects.toThrow(/maxify compress/);
    await expect(engine.compress({ path: '.git/config' })).rejects.toThrow(/excluded|does not exist/);
  });

  it('refuses files whose content holds a private key even when not indexed by name', async () => {
    await expect(engine.source({ ref: 'notes/key.txt' })).rejects.toThrow(/secret|private key/);
    await expect(engine.compress({ path: 'notes/key.txt' })).rejects.toThrow(/private key/);
  });

  it('refuses directories and non-regular files', async () => {
    await expect(engine.source({ ref: 'src/lib' })).rejects.toThrow(/regular file/);
  });
});

describe('Windows path aliases', () => {
  it.runIf(process.platform === 'win32')('rejects streams, short names, trailing dots and device names', () => {
    const guard = new RepoGuard(root);
    for (const bad of ['.env::$DATA', '.env:x', 'ENV~1', '.env.', '.env ', 'CON', 'nul.txt', 'src/COM1.ts']) {
      expect(() => guard.resolve(bad)).toThrow(/Windows alias/);
    }
    expect(guard.resolve(path.join(root, 'src', 'auth.ts'))).toBe('src/auth.ts');
    expect(guard.resolve('src\\auth.ts')).toBe('src/auth.ts');
  });

  it('accepts names that merely start with two dots', () => {
    writeFileSync(path.join(root, '..notes.md'), '# n\n');
    expect(new RepoGuard(root).resolve('..notes.md')).toBe('..notes.md');
  });
});

describe('denial of service', () => {
  it('handles a huge pathological diff header quickly', () => {
    const text = `diff --git ${' '.repeat(300_000)}\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n`;
    const started = performance.now();
    compress(text, { kind: 'diff' });
    expect(performance.now() - started).toBeLessThan(3000);
  });
});
