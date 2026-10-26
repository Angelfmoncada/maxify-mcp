import { TEST_DETECT_SCORE, testMarkerScore } from './kinds/frameworks.js';
import { splitLines, stripAnsi } from './lines.js';
import type { CompressKind } from './types.js';

/** JSON is only parsed up to this size; larger inputs are treated as text. */
export const JSON_MAX_CHARS = 5 * 1024 * 1024;
const SAMPLE_CHARS = 64 * 1024;

const SEARCH_MATCH = /^(?:[A-Za-z]:[\\/])?[^\s:]+:\d+[:-]/;
const SEARCH_CONTEXT = /^(?:[A-Za-z]:[\\/])?[^\s:]*[./\\][^\s:]*-\d+-/;
const DIAGNOSTIC = /:\d+:\d+:?\s+(?:fatal\s+)?(?:error|warning|note)\b/i;
const PATH_NO_SPACE = /^(?:[A-Za-z]:)?[^\s:*?"<>|=]+$/;
const PATH_SPACED = /^(?:[A-Za-z]:)?[^:*?"<>|=]*[\\/][^:*?"<>|=]*$/;
const PATH_SHAPE = /[\\/]|\.[A-Za-z0-9]{1,10}$/;
const TIMESTAMP = /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}|\b\d{2}:\d{2}:\d{2}\b|^\[\s*\d+(?:\.\d+)?\]|^#\d+ \d+(?:\.\d+)? /;
const LEVEL_CS = /\b(?:TRACE|DEBUG|INFO|NOTICE|WARN|WARNING|ERROR|FATAL|CRITICAL)\b/;
const LEVEL_CI = /\blevel=\w+|^\s*\[(?:trace|debug|info|warn|warning|error|fatal)\]|^(?:npm|yarn|pnpm)(?: ERR!| WARN| notice| info)/i;

/** Lines from the head and tail of the input (ANSI stripped) for cheap detection. */
export function sampleLines(text: string): string[] {
  if (text.length <= SAMPLE_CHARS * 2) return splitLines(text).map(stripAnsi);
  const head = splitLines(text.slice(0, SAMPLE_CHARS));
  head.pop();
  const tail = splitLines(text.slice(-SAMPLE_CHARS));
  tail.shift();
  return [...head, ...tail].map(stripAnsi);
}

function isDiff(lines: readonly string[]): boolean {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (line.startsWith('diff --git ')) return true;
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ') && (lines[i + 2] ?? '').startsWith('@@ ')) {
      return true;
    }
  }
  return false;
}

/** True when the input is a JSON object/array (<= 5 MB) that parses. */
export function isJsonText(text: string): boolean {
  if (text.length > JSON_MAX_CHARS) return false;
  const start = text.trimStart().replace(/^﻿/, '')[0];
  if (start !== '{' && start !== '[') return false;
  try {
    JSON.parse(text.replace(/^﻿/, ''));
    return true;
  } catch {
    return false;
  }
}

function ratio(lines: readonly string[], test: (line: string) => boolean): number {
  let total = 0;
  let hits = 0;
  for (const line of lines) {
    if (line.trim().length === 0) continue;
    total++;
    if (test(line)) hits++;
  }
  return total === 0 ? 0 : hits / total;
}

function isSearch(lines: readonly string[]): boolean {
  const matches = lines.filter((l) => SEARCH_MATCH.test(l));
  if (matches.length === 0) return false;
  if (matches.filter((l) => DIAGNOSTIC.test(l)).length >= matches.length * 0.3) return false;
  return ratio(lines, (l) => SEARCH_MATCH.test(l) || SEARCH_CONTEXT.test(l) || l === '--') >= 0.6;
}

export function isPathLike(line: string): boolean {
  if (line.length > 400 || /^[\s#*>-]/.test(line) || /^\d+$/.test(line)) return false;
  return PATH_NO_SPACE.test(line) || (PATH_SPACED.test(line) && !line.includes(': '));
}

function isList(lines: readonly string[]): boolean {
  const nonEmpty = lines.filter((l) => l.trim().length > 0);
  if (nonEmpty.length < 3) return false;
  return ratio(nonEmpty, isPathLike) >= 0.8 && ratio(nonEmpty, (l) => PATH_SHAPE.test(l)) >= 0.3;
}

function isLog(lines: readonly string[]): boolean {
  return ratio(lines, (l) => TIMESTAMP.test(l) || LEVEL_CS.test(l) || LEVEL_CI.test(l)) >= 0.25;
}

/** Best-effort kind detection (cheap: samples the head and tail of large inputs). */
export function detectKind(text: string): CompressKind {
  if (typeof text !== 'string' || text.length === 0) return 'text';
  const sample = sampleLines(text);
  if (isDiff(sample)) return 'diff';
  if (isJsonText(text)) return 'json';
  if (testMarkerScore(sample) >= TEST_DETECT_SCORE) return 'test';
  if (isSearch(sample)) return 'search';
  if (isList(sample)) return 'list';
  if (isLog(sample)) return 'log';
  return 'text';
}
