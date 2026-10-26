/**
 * Token accounting for every simulated or measured tool call.
 *
 * All counts use the single local estimator (src/core/tokens.ts), so Maxify and the native
 * baselines are compared with the same ruler. They are estimates, never Claude tokenizer counts.
 */
import { estimateTokens, TOOL_RESULT_OVERHEAD_TOKENS } from '../core/tokens.js';
import type { CallCost } from './offline-types.js';

/**
 * Cost of one tool call: the arguments the model writes, the result it reads, and the fixed
 * wrapper the client adds around every tool result (TOOL_RESULT_OVERHEAD_TOKENS).
 */
export function callCost(label: string, args: string, result: string): CallCost {
  const argTokens = estimateTokens(args);
  const resultTokens = estimateTokens(result);
  return { label, argTokens, resultTokens, tokens: argTokens + resultTokens + TOOL_RESULT_OVERHEAD_TOKENS };
}

export function sumTokens(calls: readonly CallCost[]): number {
  return calls.reduce((total, call) => total + call.tokens, 0);
}

/** Per-call overhead constant, exposed so reports can state it. */
export const PER_CALL_OVERHEAD_TOKENS = TOOL_RESULT_OVERHEAD_TOKENS;
