import { homedir } from 'node:os';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveRoot } from '../../src/cli/root.js';
import { MaxifyError } from '../../src/core/errors.js';
import { createHarness, createTempProject, type TempProject } from './helpers.js';

describe('root resolution', () => {
  let project: TempProject;
  let other: TempProject;
  beforeEach(() => {
    project = createTempProject();
    other = createTempProject();
  });
  afterEach(() => {
    project.cleanup();
    other.cleanup();
  });

  const rootUsed = async (options: Parameters<typeof createHarness>[0], ...argv: string[]): Promise<string | undefined> => {
    const h = createHarness(options);
    await h.run('query', 'x', ...argv);
    return h.opened[0]?.root;
  };

  it('prefers --root over everything', async () => {
    const root = await rootUsed(
      { cwd: project.dir, env: { MAXIFY_ROOT: other.dir, CLAUDE_PROJECT_DIR: other.dir } },
      '--root',
      other.dir,
    );
    expect(root).toBe(other.dir);
  });

  it('then MAXIFY_ROOT', async () => {
    const root = await rootUsed({ cwd: project.dir, env: { MAXIFY_ROOT: other.dir, CLAUDE_PROJECT_DIR: project.dir } });
    expect(root).toBe(other.dir);
  });

  it('then CLAUDE_PROJECT_DIR (set by Claude Code)', async () => {
    const root = await rootUsed({ cwd: project.dir, env: { CLAUDE_PROJECT_DIR: other.dir } });
    expect(root).toBe(other.dir);
  });

  it('then the nearest repository above the working directory', async () => {
    const nested = path.join(project.dir, 'packages', 'app');
    mkdirSync(nested, { recursive: true });
    expect(await rootUsed({ cwd: nested })).toBe(project.dir);
  });

  it('ignores blank environment values', async () => {
    expect(await rootUsed({ cwd: project.dir, env: { MAXIFY_ROOT: '  ', CLAUDE_PROJECT_DIR: '' } })).toBe(project.dir);
  });

  it('resolves a relative --root against the working directory', async () => {
    const nested = path.join(project.dir, 'sub');
    mkdirSync(nested);
    expect(await rootUsed({ cwd: project.dir }, '--root', 'sub')).toBe(nested);
  });

  it('reports a root that does not exist', async () => {
    const h = createHarness({ cwd: project.dir });
    expect(await h.run('query', 'x', '--root', path.join(project.dir, 'missing'))).toBe(1);
    expect(h.stderr()).toContain('not an existing directory');
    expect(h.opened).toHaveLength(0);
  });

  it('reports a root that is a file', async () => {
    const file = path.join(project.dir, 'a.txt');
    writeFileSync(file, 'x');
    const h = createHarness({ cwd: project.dir });
    expect(await h.run('query', 'x', '--root', file)).toBe(1);
    expect(h.stderr()).toContain('not an existing directory');
  });

  it('refuses the filesystem root and the home directory', async () => {
    const fsRoot = path.parse(project.dir).root;
    for (const unsafe of [fsRoot, homedir()]) {
      const h = createHarness({ cwd: project.dir });
      expect(await h.run('query', 'x', '--root', unsafe)).toBe(1);
      expect(h.stderr()).toContain('Refusing to use');
      expect(h.opened).toHaveLength(0);
    }
  });

  it('refuses an unsafe root coming from the environment too', async () => {
    const h = createHarness({ cwd: project.dir, env: { CLAUDE_PROJECT_DIR: homedir() } });
    expect(await h.run('query', 'x')).toBe(1);
    expect(h.stderr()).toContain('Refusing to use');
  });

  it('canonicalizes the root (symlinks and case) before using it', () => {
    const resolved = resolveRoot(project.dir, {}, process.cwd());
    expect(resolved.root).toBe(realpathSync.native(project.dir));
    expect(resolved.rootSource).toBe('flag');
  });

  it('names where the root came from', () => {
    expect(resolveRoot(undefined, { MAXIFY_ROOT: project.dir }, process.cwd()).rootSource).toBe('MAXIFY_ROOT');
    expect(resolveRoot(undefined, { CLAUDE_PROJECT_DIR: project.dir }, process.cwd()).rootSource).toBe('CLAUDE_PROJECT_DIR');
    expect(resolveRoot(undefined, {}, project.dir).rootSource).toBe('detected');
  });

  it('throws MaxifyError for an unusable root', () => {
    expect(() => resolveRoot(path.join(project.dir, 'nope'), {}, project.dir)).toThrow(MaxifyError);
  });
});
