import { lstatSync, readdirSync, realpathSync, statSync, type Dirent } from 'node:fs';
import path from 'node:path';
import type { RepoGuard } from '../core/paths.js';
import type { Exclusions } from './exclusions.js';

export interface WalkedFile {
  path: string;
  size: number;
  mtimeMs: number;
  /** 'noise' files are listed but not parsed. */
  noise: boolean;
}

export interface WalkResult {
  files: WalkedFile[];
  /** Count of entries skipped by class (for stats/doctor). */
  skipped: { ignored: number; secret: number; symlinkOutside: number; unreadable: number };
}

const MAX_FILES = 200_000;

function readDir(abs: string): Dirent[] | null {
  try {
    return readdirSync(abs, { withFileTypes: true });
  } catch {
    return null;
  }
}

/**
 * Iterative walk of the repository. Ignored and secret directories are pruned
 * before descending; symlinked directories are never followed; symlinked files
 * are kept only when their real target stays inside the root.
 */
export function walkRepository(guard: RepoGuard, exclusions: Exclusions): WalkResult {
  const files: WalkedFile[] = [];
  const skipped = { ignored: 0, secret: 0, symlinkOutside: 0, unreadable: 0 };
  const stack: string[] = [''];
  while (stack.length > 0 && files.length < MAX_FILES) {
    const dirRel = stack.pop() as string;
    const entries = readDir(guard.abs(dirRel));
    if (entries === null) {
      skipped.unreadable++;
      continue;
    }
    entries.sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
    for (const entry of entries) {
      const rel = dirRel === '' ? entry.name : `${dirRel}/${entry.name}`;
      if (entry.isDirectory()) {
        const cls = exclusions.classify(rel, true);
        if (cls === 'ok') stack.push(rel);
        else if (cls === 'secret') skipped.secret++;
        else skipped.ignored++;
        continue;
      }
      if (!entry.isFile() && !entry.isSymbolicLink()) continue;
      const cls = exclusions.classify(rel, false);
      if (cls === 'secret') {
        skipped.secret++;
        continue;
      }
      if (cls === 'ignored') {
        skipped.ignored++;
        continue;
      }
      const walked = statEntry(guard, rel, entry.isSymbolicLink(), cls === 'noise');
      if (walked === 'outside') skipped.symlinkOutside++;
      else if (walked === null) skipped.unreadable++;
      else files.push(walked);
    }
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { files, skipped };
}

function statEntry(guard: RepoGuard, rel: string, isLink: boolean, noise: boolean): WalkedFile | 'outside' | null {
  const abs = guard.abs(rel);
  try {
    if (isLink) {
      const real = realpathSync.native(abs);
      if (guard.relIfInside(real) === null) return 'outside';
      const target = statSync(real);
      if (!target.isFile()) return null;
      return { path: rel, size: target.size, mtimeMs: Math.floor(target.mtimeMs), noise };
    }
    const stat = lstatSync(abs);
    return { path: rel, size: stat.size, mtimeMs: Math.floor(stat.mtimeMs), noise };
  } catch {
    return null;
  }
}

/** Stat a single stored file; null if it no longer exists or became unreadable. */
export function statFile(guard: RepoGuard, rel: string): { size: number; mtimeMs: number } | null {
  try {
    const stat = statSync(path.join(guard.root, ...rel.split('/')));
    if (!stat.isFile()) return null;
    return { size: stat.size, mtimeMs: Math.floor(stat.mtimeMs) };
  } catch {
    return null;
  }
}
