import { compress } from '../compress/index.js';
import type { MaxifyConfig } from '../config/config.js';
import { MaxifyError } from '../core/errors.js';
import { fence } from '../core/fence.js';
import { sha256 } from '../core/hash.js';
import type { RepoGuard } from '../core/paths.js';
import { estimateTokens } from '../core/tokens.js';
import type { Exclusions } from '../indexer/exclusions.js';
import { readRepoText } from '../indexer/safe-read.js';
import { parseLineRange } from '../retrieval/refs.js';
import type { AuxStore } from '../store/aux-store.js';
import { MAX_BUDGET, type CompressRequest } from './types.js';

const MAX_INPUT_BYTES = 20 * 1024 * 1024;
const DAY_MS = 86_400_000;

export interface CompressDeps {
  aux: AuxStore;
  guard: RepoGuard;
  exclusions: Exclusions;
  config: MaxifyConfig;
  now: () => number;
}

export interface CompressOpResult {
  text: string;
  complete: boolean;
  extra: Record<string, unknown>;
}

function readInput(deps: CompressDeps, req: CompressRequest): { text: string; source: string } {
  const given = [req.text !== undefined, req.path !== undefined].filter(Boolean).length;
  if (given !== 1) throw new MaxifyError('INVALID_INPUT', 'pass exactly one of text, path or ref');
  if (req.text !== undefined) {
    if (Buffer.byteLength(req.text, 'utf8') > MAX_INPUT_BYTES) throw new MaxifyError('INVALID_INPUT', 'text exceeds 20 MB');
    return { text: req.text, source: 'text' };
  }
  const rel = deps.guard.resolve(req.path as string);
  const hint = ' For ignored logs, pipe the command output into the CLI instead: <cmd> 2>&1 | maxify compress';
  const { text } = readRepoText(deps.guard, deps.exclusions, rel, hint);
  return { text, source: `path:${rel}` };
}

function splitLines(text: string): string[] {
  const lines = text.split(/\r?\n/);
  if (text.endsWith('\n')) lines.pop();
  return lines;
}

/** Exact original (or a line range of it) of a previous compression. Paginated, never cut silently. */
function retrieve(deps: CompressDeps, req: CompressRequest): CompressOpResult {
  const raw = (req.ref ?? '').replace(/^blob:/i, '').trim();
  if (!/^[0-9a-f]{8,64}$/i.test(raw)) throw new MaxifyError('INVALID_INPUT', 'ref must be blob:HASH (8-64 hex chars)');
  const blob = deps.aux.getBlob(raw, deps.now());
  if (blob === null) throw new MaxifyError('NOT_FOUND', `blob:${raw} is unknown (never stored, or evicted).`);
  if (blob === 'expired') throw new MaxifyError('EXPIRED', `blob:${raw} expired; re-run the command and compress its output again.`);
  if (blob === 'ambiguous') throw new MaxifyError('AMBIGUOUS', `blob:${raw} matches several blobs; use a longer prefix.`);
  const lines = splitLines(blob.text);
  const range = req.lines ? parseLineRange(req.lines) : { start: 1, end: lines.length };
  if (range.start > lines.length) throw new MaxifyError('NOT_FOUND', `original has ${lines.length} lines; line ${range.start} does not exist.`);
  const end = Math.min(range.end, lines.length);
  const maxTokens = Math.max(200, Math.min(MAX_BUDGET, req.maxTokens ?? 6000));
  const shown: string[] = [];
  let tokens = 0;
  for (let i = range.start; i <= end; i++) {
    const line = lines[i - 1] ?? '';
    const cost = estimateTokens(line) + 1;
    if (tokens + cost > maxTokens && shown.length > 0) break;
    shown.push(line);
    tokens += cost;
  }
  const last = range.start + shown.length - 1;
  const complete = last >= end;
  const parts = [
    `maxify_compress · original blob:${blob.hash.slice(0, 12)} · lines ${range.start}-${last} of ${lines.length} · exact original (${blob.kind}, from ${blob.source})`,
    fence(shown.join('\n'), 'text'),
  ];
  if (!complete) parts.push(`continues: lines ${last + 1}-${end} — maxify_compress ref=blob:${blob.hash.slice(0, 12)} lines=${last + 1}-${end}`);
  return { text: parts.join('\n'), complete, extra: { mode: 'retrieve', lines: shown.length } };
}

/**
 * Compress command output while keeping every critical line verbatim. The exact
 * original is stored locally (gzip at rest, never shown to the model) and
 * returned as blob:HASH so any omitted line can be fetched exactly.
 */
export function compressOp(deps: CompressDeps, req: CompressRequest): CompressOpResult {
  if (req.ref !== undefined) {
    if (req.text !== undefined || req.path !== undefined) throw new MaxifyError('INVALID_INPUT', 'pass exactly one of text, path or ref');
    return retrieve(deps, req);
  }
  const { text, source } = readInput(deps, req);
  const maxTokens = Math.max(200, Math.min(MAX_BUDGET, req.maxTokens ?? deps.config.compress.defaultMaxTokens));
  const result = compress(text, { kind: req.kind ?? 'auto', maxTokens, focus: req.focus });
  const hash = sha256(text);
  const now = deps.now();
  const expiresAt = now + deps.config.compress.blobTtlDays * DAY_MS;
  const stored = result.transform !== 'none';
  if (stored) {
    deps.aux.putBlob({ hash, kind: result.kind, text, size: Buffer.byteLength(text, 'utf8'), lines: result.stats.originalLines, source, expiresAt, now });
    deps.aux.evictBlobs(now, deps.config.compress.maxStoreMB * 1024 * 1024);
  }
  const status = result.complete ? 'every critical line kept verbatim' : 'INCOMPLETE: some critical lines did not fit (listed below)';
  const where = stored
    ? `exact original: maxify_compress ref=blob:${hash.slice(0, 12)} [lines=START-END] (until ${new Date(expiresAt).toISOString().slice(0, 10)})`
    : 'original returned unchanged';
  const header = [
    `maxify_compress · ${result.kind} · ${result.transform} · est. ${result.stats.estOriginalTokens} → ${result.stats.estOutputTokens} tokens · ${status}`,
    where,
    ...result.notes.map((n) => `note: ${n}`),
  ];
  return {
    text: `${header.join('\n')}\n${result.text}`,
    complete: result.complete,
    extra: {
      mode: 'compress',
      kind: result.kind,
      transform: result.transform,
      estOriginalTokens: result.stats.estOriginalTokens,
      fellBack: result.fellBack,
      criticalLines: result.stats.criticalLines,
      criticalKept: result.stats.criticalKept,
      blob: stored ? hash.slice(0, 12) : null,
    },
  };
}
