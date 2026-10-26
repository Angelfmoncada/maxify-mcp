import { readFileSync } from 'node:fs';
import { MaxifyError } from '../core/errors.js';
import { fence, langForPath } from '../core/fence.js';
import { sha256 } from '../core/hash.js';
import type { RepoGuard } from '../core/paths.js';
import { estimateTokens } from '../core/tokens.js';
import type { EvidenceItem, SourceRequest } from '../engine/types.js';
import type { Exclusions } from '../indexer/exclusions.js';
import type { IndexStore } from '../store/index-store.js';
import type { FileRow, SymbolRow } from '../store/rows.js';
import type { EvidenceRef } from './refs.js';

export const DEFAULT_SOURCE_PAGE_TOKENS = 6000;

export interface SourceDeps {
  store: IndexStore;
  guard: RepoGuard;
  exclusions: Exclusions;
  generation: number;
}

export interface SourceResult {
  text: string;
  complete: boolean;
  item: EvidenceItem | null;
}

interface Target {
  path: string;
  start: number | null;
  end: number | null;
  symbol: SymbolRow | null;
  label: string;
}

function assertReadable(deps: SourceDeps, rel: string, file: FileRow | null): void {
  const cls = deps.exclusions.classifyWithAncestors(rel);
  if (cls === 'secret' || file?.status === 'secret') {
    throw new MaxifyError('EXCLUDED', `${rel} is classified as a secret file; Maxify never reads it.`);
  }
  if (cls === 'ignored') {
    throw new MaxifyError('EXCLUDED', `${rel} is excluded (.gitignore/.maxifyignore/config/defaults); Maxify does not serve it.`);
  }
  if (file?.status === 'binary') throw new MaxifyError('INVALID_INPUT', `${rel} is a binary file.`);
}

function symbolTarget(deps: SourceDeps, path: string, qual: string): Target {
  const file = deps.store.fileByPath(path);
  if (!file) throw new MaxifyError('NOT_FOUND', `${path} is not in the index (check the path, or run maxify index).`);
  const symbols = deps.store.symbolsOfFile(file.id);
  const exact = symbols.find((s) => s.qualName === qual) ?? symbols.filter((s) => s.name === qual);
  const found = Array.isArray(exact) ? (exact.length === 1 ? exact[0] : null) : exact;
  if (!found) {
    const options = (Array.isArray(exact) && exact.length > 1 ? exact : symbols.filter((s) => s.qualName.toLowerCase().includes(qual.toLowerCase())))
      .slice(0, 8)
      .map((s) => `${path}#${s.qualName}`);
    const hint = options.length > 0 ? ` Did you mean: ${options.join(', ')}` : '';
    throw new MaxifyError('NOT_FOUND', `No symbol "${qual}" in ${path}.${hint}`);
  }
  return { path, start: found.startLine, end: found.endLine, symbol: found, label: `${found.kind} ${found.qualName}` };
}

/** Candidates for an ambiguous bare name, rendered as a normal (non-error) answer. */
function ambiguityText(name: string, matches: Array<SymbolRow & { path: string }>): string {
  const lines = matches.slice(0, 12).map((m) => `- ${m.path}#${m.qualName} (${m.kind}, L${m.startLine}-${m.endLine}${m.exported ? ', exported' : ''})`);
  const more = matches.length > 12 ? [`- +${matches.length - 12} more; add a path prefix`] : [];
  return [`maxify_source · "${name}" matches ${matches.length} symbols; call again with one ref:`, ...lines, ...more].join('\n');
}

function resolveTarget(deps: SourceDeps, ref: EvidenceRef): Target | { ambiguous: string } {
  switch (ref.type) {
    case 'symbol':
      return symbolTarget(deps, deps.guard.resolve(ref.path), ref.qual);
    case 'range':
      return { path: deps.guard.resolve(ref.path), start: ref.start, end: ref.end, symbol: null, label: 'range' };
    case 'file':
      return { path: deps.guard.resolve(ref.path), start: null, end: null, symbol: null, label: 'whole file' };
    case 'name': {
      const matches = deps.store.symbolsByName(ref.name, 40);
      const list = matches.length > 0 ? matches : deps.store.symbolsByNameInsensitive(ref.name, 40);
      if (list.length === 0) throw new MaxifyError('NOT_FOUND', `No indexed symbol named "${ref.name}". Try maxify_context with the task, or pass path#Name.`);
      if (list.length > 1) return { ambiguous: ambiguityText(ref.name, list) };
      const only = list[0] as SymbolRow & { path: string };
      return { path: only.path, start: only.startLine, end: only.endLine, symbol: only, label: `${only.kind} ${only.qualName}` };
    }
    case 'blob':
      throw new MaxifyError('INVALID_INPUT', 'blob refs are served by maxify_compress');
  }
}

function readLines(deps: SourceDeps, rel: string): { lines: string[]; hash: string; crlf: boolean } {
  let buffer: Buffer;
  try {
    buffer = readFileSync(deps.guard.abs(rel));
  } catch {
    throw new MaxifyError('NOT_FOUND', `${rel} does not exist on disk (it may have been deleted or renamed).`);
  }
  const text = buffer.toString('utf8');
  const lines = text.split(/\r?\n/);
  if (text.endsWith('\n')) lines.pop();
  return { lines, hash: sha256(buffer), crlf: text.includes('\r\n') };
}

/** Largest prefix of `lines` (from index 0) whose rendering stays under `maxTokens`. Always at least one line. */
function pageEnd(lines: readonly string[], maxTokens: number): number {
  let tokens = 0;
  for (let i = 0; i < lines.length; i++) {
    tokens += estimateTokens(lines[i] ?? '') + 1;
    if (tokens > maxTokens && i > 0) return i;
  }
  return lines.length;
}

/**
 * Exact current source by ref. Reads from disk, verifies the hash against the
 * index (the caller re-indexes first when stale), and paginates explicitly at
 * line boundaries instead of truncating.
 */
export function readSource(deps: SourceDeps, ref: EvidenceRef, req: SourceRequest): SourceResult {
  const target = resolveTarget(deps, ref);
  if ('ambiguous' in target) return { text: target.ambiguous, complete: true, item: null };
  const file = deps.store.fileByPath(target.path);
  assertReadable(deps, target.path, file);
  const { lines, hash, crlf } = readLines(deps, target.path);
  const total = lines.length;
  const context = Math.max(0, Math.min(50, req.contextLines ?? 0));
  const start = Math.max(1, (target.start ?? 1) - context);
  const end = Math.min(total, (target.end ?? total) + context);
  if (target.start !== null && target.start > total) {
    throw new MaxifyError('NOT_FOUND', `${target.path} has ${total} lines; line ${target.start} does not exist.`);
  }
  const wanted = lines.slice(start - 1, end);
  const maxTokens = Math.max(200, req.maxTokens ?? DEFAULT_SOURCE_PAGE_TOKENS);
  const shownCount = pageEnd(wanted, maxTokens);
  const lastShown = start + shownCount - 1;
  const complete = lastShown >= end;
  const indexed = file ? (file.hash === hash ? `gen ${deps.generation}` : 'changed since index') : 'not indexed';
  const flags = crlf ? ' · CRLF' : '';
  const header = `maxify_source · ${target.path}:${start}-${lastShown} · ${target.label} · h:${hash.slice(0, 10)} · ${total} lines · ${indexed}${flags} · exact source`;
  const body = fence(wanted.slice(0, shownCount).join('\n'), langForPath(target.path));
  const parts = [header, body];
  if (!complete) {
    const rest = wanted.slice(shownCount);
    const restTokens = rest.reduce((n, l) => n + estimateTokens(l) + 1, 0);
    parts.push(`continues: lines ${lastShown + 1}-${end} not shown (~${restTokens} tok) — maxify_source ref=${target.path}:${lastShown + 1}-${end}`);
  }
  return {
    text: parts.join('\n'),
    complete,
    item: {
      ref: `${target.path}:${start}-${lastShown}`,
      path: target.path,
      startLine: start,
      endLine: lastShown,
      symbol: target.symbol?.qualName,
      level: 'source',
      provenance: 'extracted',
      hash: hash.slice(0, 12),
    },
  };
}
