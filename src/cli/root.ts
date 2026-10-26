/**
 * Repository root resolution shared by every command:
 * --root > MAXIFY_ROOT > CLAUDE_PROJECT_DIR (set by Claude Code) > nearest repository above the cwd.
 *
 * The safety checks run on the canonical path (symlinks and junctions resolved), because a link
 * that points at the filesystem root or at the home directory must be refused before any command
 * writes a file into it.
 */
import { realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { MaxifyError } from '../core/errors.js';
import { assertSafeRoot, findRepoRoot } from '../core/paths.js';
import { resolveStateDir } from '../core/state.js';
import type { GlobalOptions } from './args.js';

export type RootSource = 'flag' | 'MAXIFY_ROOT' | 'CLAUDE_PROJECT_DIR' | 'detected';

export interface RepoLocation {
  root: string;
  rootSource: RootSource;
  /** Effective state directory (explicit --state-dir or the per-repository default). */
  stateDir: string;
  /** Explicit --config path, if any. */
  configPath: string | undefined;
  /** --state-dir as given (absolute), or undefined when the default applies. */
  stateDirOverride: string | undefined;
}

function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value.trim().length > 0 ? value : undefined;
}

function assertDirectory(candidate: string, source: RootSource): void {
  let isDirectory = false;
  try {
    isDirectory = statSync(candidate).isDirectory();
  } catch {
    // Missing or unreadable: reported below as not an existing directory.
    isDirectory = false;
  }
  if (!isDirectory) {
    throw new MaxifyError('NOT_FOUND', `Repository root (${source}) is not an existing directory: ${candidate}`);
  }
}

function canonical(directory: string): string {
  try {
    return realpathSync.native(directory);
  } catch {
    // A home directory that cannot be resolved cannot be the root either.
    return path.resolve(directory);
  }
}

function sameDirectory(a: string, b: string): boolean {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** Refuse the filesystem root and the (canonical) home directory. `real` must already be canonical. */
function assertSafeCanonicalRoot(real: string): void {
  assertSafeRoot(real);
  if (sameDirectory(real, canonical(homedir()))) {
    throw new MaxifyError(
      'UNSAFE_ROOT',
      `Refusing to use ${real} as repository root (filesystem root or home directory). Pass --root <project dir>.`,
    );
  }
}

function validated(candidate: string, source: RootSource): { root: string; rootSource: RootSource } {
  assertDirectory(candidate, source);
  const real = realpathSync.native(candidate);
  assertSafeCanonicalRoot(real);
  return { root: real, rootSource: source };
}

export function resolveRoot(
  flag: string | undefined,
  env: NodeJS.ProcessEnv,
  cwd: string,
): { root: string; rootSource: RootSource } {
  const fromFlag = nonEmpty(flag);
  const fromMaxify = nonEmpty(env.MAXIFY_ROOT);
  const fromClaude = nonEmpty(env.CLAUDE_PROJECT_DIR);
  if (fromFlag !== undefined) return validated(path.resolve(cwd, fromFlag), 'flag');
  if (fromMaxify !== undefined) return validated(path.resolve(cwd, fromMaxify), 'MAXIFY_ROOT');
  if (fromClaude !== undefined) return validated(path.resolve(cwd, fromClaude), 'CLAUDE_PROJECT_DIR');
  const detected = findRepoRoot(cwd);
  assertSafeCanonicalRoot(detected);
  return { root: detected, rootSource: 'detected' };
}

export function locateRepo(globals: GlobalOptions, env: NodeJS.ProcessEnv, cwd: string): RepoLocation {
  const { root, rootSource } = resolveRoot(globals.root, env, cwd);
  const stateFlag = nonEmpty(globals.stateDir);
  const configFlag = nonEmpty(globals.config);
  const stateDirOverride = stateFlag === undefined ? undefined : path.resolve(cwd, stateFlag);
  return {
    root,
    rootSource,
    stateDir: resolveStateDir(root, stateDirOverride),
    configPath: configFlag === undefined ? undefined : path.resolve(cwd, configFlag),
    stateDirOverride,
  };
}
