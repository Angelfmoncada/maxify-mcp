import { homedir } from 'node:os';
import path from 'node:path';
import { sha256 } from './hash.js';

/**
 * Base directory for Maxify state, outside any repository so indexes are not
 * committed or synced by tools like OneDrive. Override with MAXIFY_HOME.
 */
export function maxifyHome(): string {
  const override = process.env.MAXIFY_HOME;
  if (override) return path.resolve(override);
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA ?? path.join(homedir(), 'AppData', 'Local');
    return path.join(base, 'maxify');
  }
  if (process.platform === 'darwin') return path.join(homedir(), 'Library', 'Caches', 'maxify');
  const xdg = process.env.XDG_CACHE_HOME;
  return path.join(xdg ? path.resolve(xdg) : path.join(homedir(), '.cache'), 'maxify');
}

/** Stable per-root key; worktrees and copies get distinct keys because their real paths differ. */
export function repoKey(root: string): string {
  const normalized = process.platform === 'win32' ? root.toLowerCase() : root;
  const name = path.basename(root).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 40) || 'repo';
  return `${name}-${sha256(normalized).slice(0, 12)}`;
}

/** Directory holding this repository's index database and blobs. `override` is used as-is. */
export function resolveStateDir(root: string, override?: string): string {
  if (override) return path.resolve(override);
  return path.join(maxifyHome(), 'repos', repoKey(root));
}
