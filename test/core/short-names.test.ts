import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { RepoGuard } from '../../src/core/paths.js';

const base = mkdtempSync(path.join(tmpdir(), 'maxify-short-'));
const root = path.join(base, 'a-directory-with-a-long-name');
mkdirSync(path.join(root, 'src'), { recursive: true });
writeFileSync(path.join(root, 'src', 'a.ts'), 'export const a = 1;\n');
afterAll(() => rmSync(base, { recursive: true, force: true }));

function shortName(dir: string): string {
  const out = spawnSync('cmd.exe', ['/d', '/c', `for %I in ("${dir}") do @echo %~sI`], { encoding: 'utf8', windowsVerbatimArguments: true }).stdout;
  return out.trim();
}

describe.runIf(process.platform === 'win32')('Windows 8.3 short names', () => {
  it('accepts absolute paths that spell the root with short names, and still rejects short names inside the repo', () => {
    const guard = new RepoGuard(root);
    const shortRoot = shortName(root);
    expect(guard.resolve(path.join(shortRoot, 'src', 'a.ts'))).toBe('src/a.ts');
    expect(guard.resolve(path.join(root, 'src', 'not-yet-created.ts'))).toBe('src/not-yet-created.ts');
    expect(() => guard.resolve('SRC~1/a.ts')).toThrow(/Windows alias/);
    expect(() => guard.resolve(path.join(shortRoot, '..', 'outside.ts'))).toThrow(/outside/);
  });

  it('refuses UNC and device-namespace paths before touching the filesystem', () => {
    const guard = new RepoGuard(root);
    for (const bad of ['\\\\attacker.example\\share\\x.ts', '//attacker.example/share/x.ts', '\\\\?\\C:\\x.ts', '\\\\.\\pipe\\x']) {
      expect(() => guard.resolve(bad)).toThrow(/network or device path/);
    }
  });
});
