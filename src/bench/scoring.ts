/**
 * Requirement scoring shared by Maxify results and the native simulations.
 *
 * Evidence is a list of (path, line range, level, optional symbol). A requirement
 * is satisfied when evidence covers it at >= the required level (source > signature > map):
 *
 *   source     lines of the symbol/range/file are all inside source-level evidence
 *              (adjacent or overlapping pieces are merged);
 *   signature  signature- or source-level evidence names the symbol or contains its first line;
 *   map        any evidence names the symbol or contains its first line (file refs: any evidence on the file).
 *
 * Symbol ranges come from the independent oracle (oracle.ts), never from the engine.
 */
import { countLines, findSymbol } from './oracle.js';
import { levelRank, parseRef, type Level, type ParsedRef } from './refs.js';
import type { RequirementSpec } from './offline-types.js';

export interface Evidence {
  path: string;
  startLine: number;
  endLine: number;
  symbol?: string;
  level: Level;
}

export interface Span {
  startLine: number;
  endLine: number;
}

export interface ResolvedRequirement {
  ref: string;
  level: Level;
  parsed: ParsedRef;
  /** Lines the requirement covers; null when it could not be resolved. */
  span: Span | null;
  /** Why resolution failed, when span is null. */
  problem?: string;
}

/** Locates a requirement in the given files (fixture state after any edit). */
export function resolveRequirement(spec: RequirementSpec, files: ReadonlyMap<string, string>): ResolvedRequirement {
  let parsed: ParsedRef;
  try {
    parsed = parseRef(spec.ref);
  } catch (error: unknown) {
    return { ref: spec.ref, level: spec.level, parsed: { kind: 'file', path: spec.ref }, span: null, problem: String(error) };
  }
  const base = { ref: spec.ref, level: spec.level, parsed };
  const text = files.get(parsed.path);
  if (text === undefined) return { ...base, span: null, problem: `file ${parsed.path} does not exist` };
  const lines = countLines(text);
  switch (parsed.kind) {
    case 'file':
      return { ...base, span: { startLine: 1, endLine: Math.max(lines, 1) } };
    case 'range':
      if (parsed.endLine > lines) return { ...base, span: null, problem: `range ends past line ${lines}` };
      return { ...base, span: { startLine: parsed.startLine, endLine: parsed.endLine } };
    case 'symbol': {
      const found = findSymbol(parsed.path, text, parsed.symbol);
      if (found === undefined) return { ...base, span: null, problem: `symbol ${parsed.symbol} not found in ${parsed.path}` };
      return { ...base, span: { startLine: found.startLine, endLine: found.endLine } };
    }
  }
}

function mergeSpans(spans: readonly Span[]): Span[] {
  const sorted = [...spans].sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine);
  const merged: Span[] = [];
  for (const span of sorted) {
    const last = merged[merged.length - 1];
    if (last !== undefined && span.startLine <= last.endLine + 1) {
      merged[merged.length - 1] = { startLine: last.startLine, endLine: Math.max(last.endLine, span.endLine) };
    } else {
      merged.push({ ...span });
    }
  }
  return merged;
}

/** True when the union of `evidence` spans contains every line of `span`. */
export function unionCovers(evidence: readonly Span[], span: Span): boolean {
  return mergeSpans(evidence).some((piece) => piece.startLine <= span.startLine && piece.endLine >= span.endLine);
}

function containsLine(item: Span, line: number): boolean {
  return item.startLine <= line && line <= item.endLine;
}

function overlaps(a: Span, b: Span): boolean {
  return a.startLine <= b.endLine && b.startLine <= a.endLine;
}

/** Whether `evidence` satisfies one resolved requirement. Unresolved requirements are never satisfied. */
export function isSatisfied(req: ResolvedRequirement, evidence: readonly Evidence[]): boolean {
  if (req.span === null) return false;
  const span = req.span;
  const onPath = evidence.filter((item) => item.path === req.parsed.path);
  if (onPath.length === 0) return false;
  const need = levelRank(req.level);

  if (req.level === 'source') {
    return unionCovers(onPath.filter((item) => item.level === 'source'), span);
  }
  const strong = onPath.filter((item) => levelRank(item.level) >= need);
  switch (req.parsed.kind) {
    case 'file':
      return strong.length > 0;
    case 'range':
      return strong.some((item) => overlaps(item, span));
    case 'symbol': {
      const name = req.parsed.symbol;
      return strong.some((item) => item.symbol === name || containsLine(item, span.startLine));
    }
  }
}

export interface RecallResult {
  recall: number;
  satisfied: string[];
  missed: string[];
}

/** Fraction of requirements satisfied; an empty requirement list counts as full recall. */
export function scoreRecall(requirements: readonly ResolvedRequirement[], evidence: readonly Evidence[]): RecallResult {
  const satisfied: string[] = [];
  const missed: string[] = [];
  for (const req of requirements) (isSatisfied(req, evidence) ? satisfied : missed).push(req.ref);
  const total = requirements.length;
  return { recall: total === 0 ? 1 : satisfied.length / total, satisfied, missed };
}

/** Forbidden refs that appear in the evidence at any level (directory refs end with '/'). */
export function forbiddenHits(forbidden: readonly string[], evidence: readonly Evidence[]): string[] {
  return forbidden.filter((ref) => {
    const parsed = parseRef(ref);
    return evidence.some((item) => {
      if (parsed.kind === 'file') {
        return parsed.path.endsWith('/') ? item.path.startsWith(parsed.path) : item.path === parsed.path;
      }
      if (item.path !== parsed.path) return false;
      if (parsed.kind === 'range') return overlaps(item, parsed);
      return item.symbol === parsed.symbol || (item.symbol?.startsWith(`${parsed.symbol}.`) ?? false);
    });
  });
}

/** Forbidden file paths that are merely mentioned in the returned text. */
export function forbiddenMentions(forbidden: readonly string[], text: string): string[] {
  return forbidden.filter((ref) => text.includes(parseRef(ref).path));
}
