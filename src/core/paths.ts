import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { MaxifyError } from './errors.js';

/** Convert an OS path to POSIX separators (stored paths are always POSIX, relative to root). */
export function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

function realpath(p: string): string {
  return realpathSync.native(p);
}

function sameDir(a: string, b: string): boolean {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/**
 * Find the repository root for `start`: nearest ancestor containing `.git`
 * (directory or worktree file), else nearest with package.json, else `start`.
 */
export function findRepoRoot(start: string): string {
  const begin = path.resolve(start);
  let packageDir: string | null = null;
  let dir = begin;
  for (;;) {
    if (existsSync(path.join(dir, '.git'))) return realpath(dir);
    if (packageDir === null && existsSync(path.join(dir, 'package.json'))) packageDir = dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return realpath(packageDir ?? begin);
}

/**
 * Refuse obviously unsafe roots (filesystem root, home directory) so a
 * mis-invocation never indexes a whole disk or user profile.
 */
export function assertSafeRoot(root: string): void {
  const resolved = path.resolve(root);
  if (path.parse(resolved).root === resolved || sameDir(resolved, path.resolve(homedir()))) {
    throw new MaxifyError(
      'UNSAFE_ROOT',
      `Refusing to use ${resolved} as repository root (filesystem root or home directory). Pass --root <project dir>.`,
    );
  }
}

/**
 * Validates every path that reaches the filesystem. All paths handed to the
 * model or stored in the index are POSIX paths relative to the root.
 */
export class RepoGuard {
  readonly root: string;

  constructor(root: string) {
    this.root = realpath(path.resolve(root));
  }

  /** Absolute OS path for a stored relative POSIX path. */
  abs(rel: string): string {
    return rel === '' ? this.root : path.join(this.root, ...rel.split('/'));
  }

  /** Relative POSIX path if `absPath` is lexically inside root, else null. */
  relIfInside(absPath: string): string | null {
    const rel = path.relative(this.root, absPath);
    if (rel === '') return '';
    if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
    return toPosix(rel);
  }

  /**
   * Resolve user input (absolute, or relative to root) to a validated relative
   * POSIX path. Rejects NUL bytes, escapes via '..', and symlinks whose real
   * target lies outside the root.
   */
  resolve(input: string): string {
    if (input.length === 0 || input.includes('\0')) {
      throw new MaxifyError('INVALID_INPUT', 'Path is empty or contains a NUL byte.');
    }
    const cleaned = input.replace(/^file:\/\//, '');
    const absolute = path.resolve(this.root, cleaned);
    const rel = this.relIfInside(absolute);
    if (rel === null) {
      throw new MaxifyError('OUT_OF_ROOT', `Path "${input}" is outside the repository root.`);
    }
    if (existsSync(absolute)) {
      const real = realpath(absolute);
      if (this.relIfInside(real) === null) {
        throw new MaxifyError('OUT_OF_ROOT', `Path "${input}" resolves (via symlink) outside the repository root.`);
      }
    }
    return rel;
  }
}
