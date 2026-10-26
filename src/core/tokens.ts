/**
 * Local token ESTIMATOR.
 *
 * Claude's tokenizer is not public, so Maxify never claims exact counts.
 * This heuristic approximates a BPE tokenizer by splitting text into words
 * (camelCase-aware), digit groups, punctuation runs and whitespace, and is
 * tuned to slightly over-estimate typical code (~3.5 chars/token) and prose
 * (~4.2 chars/token). Budgets enforced with it therefore err on the safe side.
 * Provider-reported usage (benchmarks) is the only source of real counts.
 */

const PIECE = /\p{L}+|\p{N}+|[ \t]+|\r?\n|[^\p{L}\p{N}\s]+|\s/gu;
const CAMEL_SPLIT = /(?<=\p{Ll})(?=\p{Lu})|(?<=\p{Lu})(?=\p{Lu}\p{Ll})/u;
const WIDE_CHAR = /[　-鿿가-힯豈-﫿]/u;

function wordCost(word: string): number {
  let cost = 0;
  for (const part of word.split(CAMEL_SPLIT)) {
    if (part.length === 0) continue;
    if (WIDE_CHAR.test(part)) {
      cost += part.length;
    } else if (part.length <= 8) {
      cost += 1;
    } else {
      cost += Math.ceil(part.length / 5);
    }
  }
  return cost;
}

function pieceCost(piece: string): number {
  const first = piece[0] ?? '';
  if (/\p{L}/u.test(first)) return wordCost(piece);
  if (/\p{N}/u.test(first)) return Math.ceil(piece.length / 3);
  if (piece === '\n' || piece === '\r\n') return 1;
  if (first === ' ' || first === '\t') return piece.length <= 1 ? 0 : Math.ceil(piece.length / 4);
  if (/\s/u.test(first)) return 1;
  // Punctuation runs: common pairs like '=>' or '();' often merge.
  return Math.ceil(piece.length * 0.75);
}

/** Estimated token count of `text` (heuristic, see module comment). */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  let total = 0;
  for (const match of text.matchAll(PIECE)) {
    total += pieceCost(match[0]);
  }
  return total;
}

/** Fixed per-result overhead the client adds around a tool result (wrapper, ids). Estimate. */
export const TOOL_RESULT_OVERHEAD_TOKENS = 12;
