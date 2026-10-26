/**
 * Recoverable compression contract.
 *
 * `compress()` is a pure function: it never stores anything. The engine
 * stores the exact original (blob) and prefixes the result with a header
 * carrying the blob ref, so every omitted line stays recoverable.
 *
 * Line numbers mentioned in `text` always refer to 1-based lines of the
 * ORIGINAL input (split on /\r?\n/), so `maxify_compress {ref, lines}` can
 * return them exactly.
 */

export type CompressKind = 'log' | 'test' | 'search' | 'json' | 'list' | 'diff' | 'text';
export type CompressKindInput = CompressKind | 'auto';

/** Strongest transformation applied, ordered by information loss. */
export type TransformClass =
  /** Original returned unchanged. */
  | 'none'
  /** Lossless re-formatting: ANSI/trailing-space stripping, JSON minification, collapsing \r progress redraws. */
  | 'format'
  /** Verbatim subset of original lines, with counts and line locations of everything omitted. */
  | 'selection'
  /** Derived aggregate (lossy): grouped templates, shapes, statistics. Clearly labeled in text. */
  | 'summary';

export interface CompressOptions {
  /** Default 'auto' (detectKind). */
  kind?: CompressKindInput;
  /** Target size of `text` in estimated tokens. Default DEFAULT_COMPRESS_MAX_TOKENS. */
  maxTokens?: number;
  /** Terms whose lines must be kept verbatim (case-insensitive substring match). */
  focus?: string[];
}

export interface CompressStats {
  originalLines: number;
  originalChars: number;
  outputChars: number;
  estOriginalTokens: number;
  estOutputTokens: number;
  /** Distinct critical lines found (errors, failures, assertion diffs, focus hits, summaries). */
  criticalLines: number;
  /** Critical lines present verbatim in `text`. Equals criticalLines unless complete === false. */
  criticalKept: number;
  /** Original lines not shown verbatim. */
  omittedLines: number;
}

export interface CompressResult {
  /** Detected or requested kind. */
  kind: CompressKind;
  transform: TransformClass;
  /** Body for the model (the engine adds the header with the blob ref). */
  text: string;
  /**
   * False when some critical lines could not fit; `text` then says so explicitly
   * and gives their original line numbers. Never a silent omission.
   */
  complete: boolean;
  /** True when the original was returned because compression did not help or was unsafe. */
  fellBack: boolean;
  stats: CompressStats;
  /** Plain statements of what was done, e.g. "312 repeated lines collapsed into 4 groups". */
  notes: string[];
}

export const DEFAULT_COMPRESS_MAX_TOKENS = 1200;
