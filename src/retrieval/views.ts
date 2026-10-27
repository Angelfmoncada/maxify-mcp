import { readFileSync } from 'node:fs';
import { sha256 } from '../core/hash.js';
import type { RepoGuard } from '../core/paths.js';
import type { FileRow } from '../store/rows.js';
import type { FileView } from './render.js';

/**
 * Reads files from disk once per request and verifies them against the index:
 * evidence is only rendered when the bytes on disk still hash to the indexed hash.
 */
export class FileViews {
  private readonly guard: RepoGuard;
  private readonly cache = new Map<string, FileView | null>();
  /** Paths whose on-disk content no longer matches the index. */
  readonly stale = new Set<string>();
  /** Code files no test or entry point reaches (flagged when rendered). */
  readonly unreached = new Set<string>();

  constructor(guard: RepoGuard) {
    this.guard = guard;
  }

  view(file: FileRow): FileView | null {
    if (this.cache.has(file.path)) return this.cache.get(file.path) ?? null;
    let view: FileView | null = null;
    try {
      const buffer = readFileSync(this.guard.abs(file.path));
      const hash = sha256(buffer);
      if (hash !== file.hash) {
        this.stale.add(file.path);
      } else {
        const text = buffer.toString('utf8');
        const lines = text.split(/\r?\n/);
        if (text.endsWith('\n')) lines.pop();
        view = { hash, lines, crlf: text.includes('\r\n') };
      }
    } catch {
      this.stale.add(file.path);
    }
    this.cache.set(file.path, view);
    return view;
  }
}
