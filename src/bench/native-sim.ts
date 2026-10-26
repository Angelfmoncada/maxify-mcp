/**
 * Deterministic SIMULATIONS of how an agent without Maxify gathers context with grep and file reads.
 * They are not agent behavior: no model is involved, ranking is keyword counting, and both
 * strategies are intentionally charitable to the baseline (see each function).
 *
 * A: grep-read-files   one grep listing of matching files with hit counts, then `cat -n` of the top 3 files.
 * B: grep-read-ranges  one `grep -n` listing, then the best 8 windows of +/-25 lines around hits
 *                      (overlapping windows merged per file), each read with line numbers.
 *
 * Cost per call = tokens of the command + tokens of its output + the per-call overhead (cost.ts).
 * Output lines are rendered `cat -n` style: a 6-wide right-aligned line number, a tab, the text.
 */
import { callCost, sumTokens } from './cost.js';
import { extractKeywords } from './keywords.js';
import type { CallCost, SimRun } from './offline-types.js';
import type { Evidence } from './scoring.js';

export const GREP_READ_FILE_COUNT = 3;
export const WINDOW_RADIUS = 25;
export const MAX_WINDOWS = 8;
export const MAX_LISTING_LINES = 80;

export interface GrepHit {
  path: string;
  line: number;
  text: string;
  /** Keywords found on this line. */
  matched: string[];
}

export interface SimOutcome {
  strategy: SimRun['strategy'];
  keywords: string[];
  perCall: CallCost[];
  tokens: number;
  calls: number;
  /** What the simulated agent saw: listings count as map-level, reads as source-level evidence. */
  evidence: Evidence[];
  /** Reads as 'path' (whole file) or 'path:START-END'. */
  reads: string[];
}

function splitLines(text: string): string[] {
  const lines = text.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** `cat -n` rendering of a block of lines starting at `firstLine`. */
export function renderCatN(lines: readonly string[], firstLine: number): string {
  return lines.map((line, index) => `${String(firstLine + index).padStart(6)}\t${line}`).join('\n');
}

/** Case-insensitive substring search over every file, in sorted path order. */
export function grepFiles(files: ReadonlyMap<string, string>, keywords: readonly string[]): GrepHit[] {
  const needles = keywords.map((keyword) => keyword.toLowerCase());
  const hits: GrepHit[] = [];
  for (const path of [...files.keys()].sort()) {
    const lines = splitLines(files.get(path) ?? '');
    lines.forEach((text, index) => {
      const lower = text.toLowerCase();
      const matched = needles.filter((needle) => lower.includes(needle));
      if (matched.length > 0) hits.push({ path, line: index + 1, text, matched });
    });
  }
  return hits;
}

function grepPattern(keywords: readonly string[]): string {
  return keywords.map((keyword) => keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
}

interface FileScore {
  path: string;
  distinct: number;
  lines: number;
}

function rankFiles(hits: readonly GrepHit[]): FileScore[] {
  const byFile = new Map<string, { keywords: Set<string>; lines: number }>();
  for (const hit of hits) {
    const entry = byFile.get(hit.path) ?? { keywords: new Set<string>(), lines: 0 };
    for (const keyword of hit.matched) entry.keywords.add(keyword);
    entry.lines += 1;
    byFile.set(hit.path, entry);
  }
  return [...byFile.entries()]
    .map(([path, entry]) => ({ path, distinct: entry.keywords.size, lines: entry.lines }))
    .sort((a, b) => b.distinct - a.distinct || b.lines - a.lines || a.path.localeCompare(b.path));
}

function emptyOutcome(strategy: SimRun['strategy'], keywords: string[], command: string): SimOutcome {
  const perCall = [callCost('grep', command, '')];
  return { strategy, keywords, perCall, tokens: sumTokens(perCall), calls: 1, evidence: [], reads: [] };
}

/** Simulation A. Ranking uses hit counts that plain `grep -l` would not print, which favors the baseline. */
export function simulateGrepReadFiles(files: ReadonlyMap<string, string>, prompt: string): SimOutcome {
  const keywords = extractKeywords(prompt);
  const command = `grep -rciE "${grepPattern(keywords)}" .`;
  const ranked = rankFiles(grepFiles(files, keywords));
  if (ranked.length === 0) return emptyOutcome('grep-read-files', keywords, command);

  const listing = ranked.map((file) => `${file.path}:${file.lines}`).join('\n');
  const perCall: CallCost[] = [callCost('grep', command, listing)];
  const evidence: Evidence[] = ranked.map((file) => ({ path: file.path, startLine: 1, endLine: 1, level: 'map' }));
  const reads: string[] = [];

  for (const file of ranked.slice(0, GREP_READ_FILE_COUNT)) {
    const lines = splitLines(files.get(file.path) ?? '');
    perCall.push(callCost('cat -n', `cat -n ${file.path}`, renderCatN(lines, 1)));
    evidence.push({ path: file.path, startLine: 1, endLine: Math.max(lines.length, 1), level: 'source' });
    reads.push(file.path);
  }
  return { strategy: 'grep-read-files', keywords, perCall, tokens: sumTokens(perCall), calls: perCall.length, evidence, reads };
}

interface Window {
  path: string;
  startLine: number;
  endLine: number;
  distinct: number;
  hitLines: number;
}

function buildWindows(hits: readonly GrepHit[], files: ReadonlyMap<string, string>): Window[] {
  const windows: Window[] = [];
  const paths = [...new Set(hits.map((hit) => hit.path))].sort();
  for (const path of paths) {
    const total = splitLines(files.get(path) ?? '').length;
    const fileHits = hits.filter((hit) => hit.path === path);
    let current: { start: number; end: number; keywords: Set<string>; hitLines: number } | null = null;
    for (const hit of fileHits) {
      const start = Math.max(1, hit.line - WINDOW_RADIUS);
      const end = Math.min(total, hit.line + WINDOW_RADIUS);
      if (current !== null && start <= current.end + 1) {
        current.end = Math.max(current.end, end);
        current.hitLines += 1;
        for (const keyword of hit.matched) current.keywords.add(keyword);
      } else {
        if (current !== null) windows.push(finishWindow(path, current));
        current = { start, end, keywords: new Set(hit.matched), hitLines: 1 };
      }
    }
    if (current !== null) windows.push(finishWindow(path, current));
  }
  return windows;
}

function finishWindow(
  path: string,
  state: { start: number; end: number; keywords: Set<string>; hitLines: number },
): Window {
  return { path, startLine: state.start, endLine: state.end, distinct: state.keywords.size, hitLines: state.hitLines };
}

/** Simulation B. Windows are chosen with knowledge of all hits, which favors the baseline. */
export function simulateGrepReadRanges(files: ReadonlyMap<string, string>, prompt: string): SimOutcome {
  const keywords = extractKeywords(prompt);
  const hits = grepFiles(files, keywords);
  const command = `grep -rnE "${grepPattern(keywords)}" . | head -${MAX_LISTING_LINES}`;
  if (hits.length === 0) return emptyOutcome('grep-read-ranges', keywords, command);

  const chosen = buildWindows(hits, files)
    .sort(
      (a, b) =>
        b.distinct - a.distinct ||
        b.hitLines - a.hitLines ||
        a.path.localeCompare(b.path) ||
        a.startLine - b.startLine,
    )
    .slice(0, MAX_WINDOWS)
    .sort((a, b) => a.path.localeCompare(b.path) || a.startLine - b.startLine);

  const inChosen = (hit: GrepHit): boolean =>
    chosen.some((win) => win.path === hit.path && hit.line >= win.startLine && hit.line <= win.endLine);
  const listing = hits
    .filter(inChosen)
    .slice(0, MAX_LISTING_LINES)
    .map((hit) => `${hit.path}:${hit.line}:${hit.text}`)
    .join('\n');

  const perCall: CallCost[] = [callCost('grep -n', command, listing)];
  const listedPaths = [...new Set(hits.filter(inChosen).slice(0, MAX_LISTING_LINES).map((hit) => hit.path))];
  const evidence: Evidence[] = listedPaths.map((path) => ({ path, startLine: 1, endLine: 1, level: 'map' }));
  const reads: string[] = [];

  for (const win of chosen) {
    const lines = splitLines(files.get(win.path) ?? '').slice(win.startLine - 1, win.endLine);
    const label = `${win.path}:${win.startLine}-${win.endLine}`;
    perCall.push(callCost('read range', `Read ${win.path} offset=${win.startLine} limit=${lines.length}`, renderCatN(lines, win.startLine)));
    evidence.push({ path: win.path, startLine: win.startLine, endLine: win.endLine, level: 'source' });
    reads.push(label);
  }
  return { strategy: 'grep-read-ranges', keywords, perCall, tokens: sumTokens(perCall), calls: perCall.length, evidence, reads };
}
