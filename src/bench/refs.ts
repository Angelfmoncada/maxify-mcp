/**
 * Reference grammar shared by task specs, scoring and follow-up calls.
 *
 *   path                 whole file
 *   path#Qual.Name       a symbol ('Class.method', 'suite > test title', markdown heading text)
 *   path:START-END       a 1-based inclusive line range ('path:LINE' is a one-line range)
 *
 * All paths are POSIX paths relative to the fixture root.
 */

export const LEVELS = ['map', 'signature', 'source'] as const;

export type Level = (typeof LEVELS)[number];

const LEVEL_RANK: Record<Level, number> = { map: 0, signature: 1, source: 2 };

/** Ordering of detail levels: source > signature > map. */
export function levelRank(level: Level): number {
  return LEVEL_RANK[level];
}

export function isLevel(value: unknown): value is Level {
  return typeof value === 'string' && (LEVELS as readonly string[]).includes(value);
}

export type ParsedRef =
  | { kind: 'file'; path: string }
  | { kind: 'symbol'; path: string; symbol: string }
  | { kind: 'range'; path: string; startLine: number; endLine: number };

const RANGE_SUFFIX = /^(.+):(\d+)(?:-(\d+))?$/;

/** Parses a reference string. Throws on an empty path or an inverted range. */
export function parseRef(ref: string): ParsedRef {
  const hash = ref.indexOf('#');
  if (hash >= 0) {
    const path = ref.slice(0, hash);
    const symbol = ref.slice(hash + 1);
    if (path.length === 0 || symbol.length === 0) throw new Error(`Invalid symbol ref "${ref}"`);
    return { kind: 'symbol', path, symbol };
  }
  const match = RANGE_SUFFIX.exec(ref);
  if (match !== null) {
    const startLine = Number(match[2]);
    const endLine = match[3] === undefined ? startLine : Number(match[3]);
    if (startLine < 1 || endLine < startLine) throw new Error(`Invalid line range in "${ref}"`);
    return { kind: 'range', path: match[1] ?? '', startLine, endLine };
  }
  if (ref.length === 0) throw new Error('Empty ref');
  return { kind: 'file', path: ref };
}

/** Canonical string form of a parsed reference (inverse of parseRef). */
export function formatRef(ref: ParsedRef): string {
  switch (ref.kind) {
    case 'file':
      return ref.path;
    case 'symbol':
      return `${ref.path}#${ref.symbol}`;
    case 'range':
      return `${ref.path}:${ref.startLine}-${ref.endLine}`;
  }
}

/** Path part of any reference. */
export function refPath(ref: string): string {
  return parseRef(ref).path;
}
