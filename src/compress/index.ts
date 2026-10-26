/**
 * Recoverable compression of tool output (logs, test runs, search results,
 * JSON, listings, diffs). Pure: no fs, storage, network or shell.
 *
 * Guarantees: critical lines (failures, assertion details, summaries, exit
 * codes, focus hits) are kept verbatim or explicitly listed by line number;
 * every omission names its original line range; output that would not save
 * at least 15% falls back to the unchanged original. Body format: markers.ts.
 */
import { estimateTokens } from '../core/tokens.js';
import { hasFailureWord, hasFocus, normalizeFocus } from './classify.js';
import { detectKind } from './detect.js';
import { fitLines } from './fit.js';
import { compressDiff } from './kinds/diff.js';
import { compressJson } from './kinds/json.js';
import { compressList } from './kinds/list.js';
import { planLog } from './kinds/log.js';
import { compressSearch } from './kinds/search.js';
import { planTest } from './kinds/test.js';
import { prepare, splitLines, verificationLines } from './lines.js';
import { chooseMarker, lref } from './markers.js';
import { fromFit, type KindContext, type KindOutput } from './output.js';
import type { Critical } from './plan.js';
import {
  DEFAULT_COMPRESS_MAX_TOKENS,
  type CompressKind,
  type CompressKindInput,
  type CompressOptions,
  type CompressResult,
} from './types.js';

export { detectKind } from './detect.js';

/** Inputs at or below this size (and within budget) are returned unchanged. */
export const SMALL_INPUT_TOKENS = 400;
/** Compressed bodies at or above this share of the original fall back to the original. */
export const FALLBACK_RATIO = 0.85;
const MIN_MAX_TOKENS = 50;
const KINDS: ReadonlySet<string> = new Set(['log', 'test', 'search', 'json', 'list', 'diff', 'text']);

function resolveMaxTokens(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return DEFAULT_COMPRESS_MAX_TOKENS;
  return Math.max(MIN_MAX_TOKENS, Math.floor(value));
}

function resolveKind(value: unknown): CompressKindInput {
  return typeof value === 'string' && KINDS.has(value) ? (value as CompressKind) : 'auto';
}

function countLines(text: string): number {
  if (text.length === 0) return 0;
  let n = 1;
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) n++;
  return text.endsWith('\n') ? n - 1 : n;
}

function lineKind(kind: 'log' | 'text' | 'test', text: string, ctx: KindContext): KindOutput {
  const prepared = prepare(text, {
    trimTrailing: true,
    keepSegment: (s) => hasFailureWord(s) || hasFocus(s, ctx.focus),
  });
  const marker = ctx.markerFor(prepared.lines);
  const plan = kind === 'test' ? planTest(prepared.lines, ctx.focus) : planLog(prepared.lines, ctx.focus);
  const cleaning: string[] = [];
  if (prepared.ansiLines > 0) cleaning.push(`ANSI codes stripped from ${prepared.ansiLines} lines`);
  if (prepared.redraws > 0) cleaning.push(`${prepared.redraws} \\r progress redraws collapsed to their last state`);
  const fit = fitLines({ ...plan, notes: [...plan.notes, ...cleaning] }, { maxTokens: ctx.maxTokens, target: ctx.target, marker });
  return fromFit(kind, fit);
}

function withNote(out: KindOutput, note: string): KindOutput {
  return { ...out, notes: [note, ...out.notes] };
}

function runKind(kind: CompressKind, text: string, ctx: KindContext): KindOutput {
  switch (kind) {
    case 'search':
      return compressSearch(text, ctx) ?? withNote(lineKind('text', text, ctx), 'input is not mostly search results; compressed as text');
    case 'list':
      return compressList(text, ctx) ?? withNote(lineKind('text', text, ctx), 'input is not mostly paths; compressed as text');
    case 'diff':
      return compressDiff(text, ctx) ?? withNote(lineKind('text', text, ctx), 'no unified diff found; compressed as text');
    case 'json':
      return compressJson(text, ctx) ?? withNote(lineKind('text', text, ctx), 'JSON.parse failed or input over 5 MB; compressed as text');
    case 'test':
    case 'log':
    case 'text':
      return lineKind(kind, text, ctx);
  }
}

function safeRun(kind: CompressKind, text: string, ctx: KindContext): KindOutput | Error {
  try {
    return runKind(kind, text, ctx);
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    if (kind === 'text') return new Error(reason);
    try {
      return withNote(runKind('text', text, ctx), `${kind} compressor failed (${reason}); compressed as text`);
    } catch (inner: unknown) {
      return new Error(`${reason}; text compressor: ${inner instanceof Error ? inner.message : String(inner)}`);
    }
  }
}

interface Verified {
  text: string;
  kept: number;
  restored: number;
}

/** Checks every critical item against the output; restores any that are missing by mistake. */
function verify(out: KindOutput, original: string): Verified {
  const present = (text: string): ((c: Critical) => boolean) => {
    const set = verificationLines(text);
    return (c) => (c.inline === true ? text.includes(c.text) : set.has(c.text));
  };
  let text = out.text;
  let has = present(text);
  const deliberate = new Set(out.omittedCritical);
  const missing = out.critical.filter((c) => !has(c) && !deliberate.has(c.line));
  if (missing.length > 0) {
    const marker = chooseMarker(splitLines(original));
    const block = [`${marker} critical lines restored (missing from the layout above):`];
    for (const c of missing) {
      if (c.inline === true) block.push(`${marker} ${lref(c.line)}: ${c.text}`);
      else block.push(`${marker} ${lref(c.line)}`, c.text);
    }
    text = `${text}\n${block.join('\n')}`;
    has = present(text);
  }
  return { text, kept: out.critical.filter(has).length, restored: missing.length };
}

interface Base {
  kind: CompressKind;
  original: string;
  originalLines: number;
  estOriginal: number;
}

function unchanged(base: Base, criticalLines: number, notes: string[]): CompressResult {
  return {
    kind: base.kind,
    transform: 'none',
    text: base.original,
    complete: true,
    fellBack: true,
    stats: {
      originalLines: base.originalLines,
      originalChars: base.original.length,
      outputChars: base.original.length,
      estOriginalTokens: base.estOriginal,
      estOutputTokens: base.estOriginal,
      criticalLines,
      criticalKept: criticalLines,
      omittedLines: 0,
    },
    notes,
  };
}

/** Compresses tool output to roughly `maxTokens` estimated tokens without losing critical evidence. */
export function compress(text: string, opts: CompressOptions = {}): CompressResult {
  const original = typeof text === 'string' ? text : String(text);
  const maxTokens = resolveMaxTokens(opts.maxTokens);
  const focus = normalizeFocus(opts.focus);
  const requested = resolveKind(opts.kind);
  const detected = requested === 'auto' ? detectKind(original) : requested;
  const estOriginal = estimateTokens(original);
  const base: Base = { kind: detected, original, originalLines: countLines(original), estOriginal };
  const kindNote = `kind ${detected} (${requested === 'auto' ? 'detected' : 'requested'})`;
  if (original.length === 0) return unchanged(base, 0, [kindNote, 'empty input; returned unchanged']);
  const target = estOriginal <= maxTokens ? maxTokens : Math.min(maxTokens, Math.ceil(estOriginal * FALLBACK_RATIO) - 1);
  const needsMarkerCheck = original.includes('» ');
  const ctx: KindContext = {
    maxTokens,
    target: Math.max(1, target),
    focus,
    markerFor: (lines) => (needsMarkerCheck ? chooseMarker(lines) : '»'),
  };
  const out = safeRun(detected, original, ctx);
  if (out instanceof Error) {
    return unchanged(base, 0, [kindNote, `compression failed (${out.message}); returned unchanged`]);
  }
  const result = { ...base, kind: out.kind };
  if (estOriginal <= maxTokens && estOriginal <= SMALL_INPUT_TOKENS) {
    return unchanged(result, out.critical.length, [kindNote, `input is small (${estOriginal} est. tokens <= ${SMALL_INPUT_TOKENS}); returned unchanged`]);
  }
  const verified = verify(out, original);
  const estOutput = estimateTokens(verified.text);
  if (estOutput >= estOriginal * FALLBACK_RATIO) {
    const pct = Math.round((estOutput / Math.max(1, estOriginal)) * 100);
    return unchanged(result, out.critical.length, [
      kindNote,
      `compressed body would be ${pct}% of the original (${estOutput}/${estOriginal} est. tokens); returned unchanged`,
    ]);
  }
  const notes = [kindNote, ...out.notes, `${estOriginal} -> ${estOutput} est. tokens (budget ${maxTokens})`];
  if (verified.restored > 0) notes.push(`${verified.restored} critical lines were missing from the layout and were restored at the end`);
  return {
    kind: out.kind,
    transform: out.transform,
    text: verified.text,
    complete: verified.kept === out.critical.length,
    fellBack: false,
    stats: {
      originalLines: base.originalLines,
      originalChars: original.length,
      outputChars: verified.text.length,
      estOriginalTokens: estOriginal,
      estOutputTokens: estOutput,
      criticalLines: out.critical.length,
      criticalKept: verified.kept,
      omittedLines: out.omittedLines,
    },
    notes,
  };
}

export type { CompressKind, CompressKindInput, CompressOptions, CompressResult } from './types.js';
