import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadConfig, DEFAULT_CONFIG } from '../../src/config/config.js';
import { MaxifyError } from '../../src/core/errors.js';
import { fence, langForPath } from '../../src/core/fence.js';
import { stableStringify } from '../../src/core/hash.js';
import { assertSafeRoot, findRepoRoot, RepoGuard } from '../../src/core/paths.js';
import { repoKey, resolveStateDir } from '../../src/core/state.js';
import { estimateTokens } from '../../src/core/tokens.js';

const tmp = mkdtempSync(path.join(tmpdir(), 'maxify-core-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('estimateTokens', () => {
  it('is zero for empty text and grows with length', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('a b c d')).toBeLessThan(estimateTokens('a b c d e f g h i j'));
  });

  it('lands in a plausible chars/token range for code and prose (heuristic, slightly conservative)', () => {
    const code = 'export function requireAuth(req: Request, res: Response, next: NextFunction): void {\n  if (!req.headers.authorization) {\n    return res.status(401).json({ error: "missing token" });\n  }\n  next();\n}\n'.repeat(20);
    const prose = 'The middleware rejects requests whose token expired before the current time, and it logs the reason for auditing purposes. '.repeat(20);
    const codeRatio = code.length / estimateTokens(code);
    const proseRatio = prose.length / estimateTokens(prose);
    expect(codeRatio).toBeGreaterThan(2.2);
    expect(codeRatio).toBeLessThan(4.5);
    expect(proseRatio).toBeGreaterThan(3.2);
    expect(proseRatio).toBeLessThan(6);
  });

  it('counts wide CJK characters individually', () => {
    expect(estimateTokens('漢字テスト')).toBeGreaterThanOrEqual(5);
  });
});

describe('fence', () => {
  it('uses a fence longer than any backtick run in the content', () => {
    const out = fence('const a = `x`;\n```nested```', 'ts');
    expect(out.startsWith('````ts\n')).toBe(true);
    expect(out.endsWith('\n````')).toBe(true);
  });

  it('maps extensions to languages', () => {
    expect(langForPath('src/a.tsx')).toBe('tsx');
    expect(langForPath('README')).toBe('');
  });
});

describe('stableStringify', () => {
  it('sorts keys and drops undefined values', () => {
    expect(stableStringify({ b: 1, a: [2, { d: undefined, c: 3 }] })).toBe('{"a":[2,{"c":3}],"b":1}');
  });
});

describe('RepoGuard', () => {
  const root = path.join(tmp, 'repo');
  mkdirSync(path.join(root, 'src'), { recursive: true });
  writeFileSync(path.join(root, 'src', 'a.ts'), 'export const a = 1;\n');
  const guard = new RepoGuard(root);

  it('resolves relative and absolute paths inside the root to POSIX relative paths', () => {
    expect(guard.resolve('src/a.ts')).toBe('src/a.ts');
    expect(guard.resolve(path.join(root, 'src', 'a.ts'))).toBe('src/a.ts');
    expect(guard.resolve('./src/../src/a.ts')).toBe('src/a.ts');
  });

  it('rejects escapes, NUL bytes and empty paths', () => {
    expect(() => guard.resolve('../outside.ts')).toThrow(MaxifyError);
    expect(() => guard.resolve(path.join(tmp, 'other.ts'))).toThrow(/outside the repository root/);
    expect(() => guard.resolve('src/a\0.ts')).toThrow(/NUL/);
    expect(() => guard.resolve('')).toThrow(MaxifyError);
  });

  it('rejects symlinks that point outside the root (when the OS allows creating them)', () => {
    const outside = path.join(tmp, 'secret.txt');
    writeFileSync(outside, 'secret');
    const link = path.join(root, 'link.txt');
    try {
      symlinkSync(outside, link);
    } catch {
      return; // symlink creation needs privileges on some Windows setups
    }
    expect(() => guard.resolve('link.txt')).toThrow(/symlink/);
  });
});

describe('roots and state', () => {
  it('finds the nearest .git ancestor', () => {
    const repo = path.join(tmp, 'gitrepo');
    mkdirSync(path.join(repo, '.git'), { recursive: true });
    mkdirSync(path.join(repo, 'pkg', 'src'), { recursive: true });
    expect(findRepoRoot(path.join(repo, 'pkg', 'src')).toLowerCase()).toBe(path.resolve(repo).toLowerCase());
  });

  it('refuses the filesystem root and the home directory', () => {
    expect(() => assertSafeRoot(path.parse(process.cwd()).root)).toThrow(/Refusing/);
    expect(() => assertSafeRoot(homedir())).toThrow(/Refusing/);
  });

  it('gives distinct state dirs to distinct roots (worktree isolation)', () => {
    expect(repoKey('/a/repo')).not.toBe(repoKey('/b/repo'));
    expect(resolveStateDir('/a/repo', path.join(tmp, 'state'))).toBe(path.join(tmp, 'state'));
  });
});

describe('config', () => {
  it('returns defaults without a config file', () => {
    const loaded = loadConfig(path.join(tmp, 'repo'));
    expect(loaded.config).toEqual(DEFAULT_CONFIG);
    expect(loaded.source).toBeNull();
  });

  it('merges a partial config and changes the hash', () => {
    const dir = path.join(tmp, 'cfg');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'maxify.config.json'), JSON.stringify({ exclude: ['fixtures/'], context: { defaultBudget: 6000 } }));
    const loaded = loadConfig(dir);
    expect(loaded.config.exclude).toEqual(['fixtures/']);
    expect(loaded.config.context.defaultBudget).toBe(6000);
    expect(loaded.config.context.includeTests).toBe(true);
    expect(loaded.hash).not.toBe(loadConfig(path.join(tmp, 'repo')).hash);
  });

  it('rejects unknown keys and invalid JSON with a clear message', () => {
    const dir = path.join(tmp, 'bad');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'maxify.config.json'), JSON.stringify({ budget: 1 }));
    expect(() => loadConfig(dir)).toThrow(/Invalid maxify.config.json/);
    writeFileSync(path.join(dir, 'maxify.config.json'), '{ nope');
    expect(() => loadConfig(dir)).toThrow(/Invalid JSON/);
  });
});
