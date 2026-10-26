/**
 * Input limits shared by the MCP tools and the CLI so both front ends reject
 * the same inputs, and the same inputs the engine accepts. Kept free of
 * zod/SDK imports so the CLI can use it cheaply. test/mcp/limits.test.ts pins
 * the values that mirror engine constants.
 */
import { MAX_BUDGET, MIN_BUDGET } from '../engine/types.js';
import { MAX_TASK_CHARS } from '../engine/validate.js';

export const LIMITS = {
  contextLines: { min: 0, max: 50 },
  depth: { min: 1, max: 5 },
  targets: { min: 1, max: 20 },
  /** Page / output size in estimated tokens. The engine raises anything below MIN_BUDGET to it. */
  pageTokens: { min: MIN_BUDGET, max: MAX_BUDGET },
  budget: { min: MIN_BUDGET, max: MAX_BUDGET },
  /** The engine caps memory listings at 50 notes. */
  memoryLimit: { min: 1, max: 50 },
  memoryTextChars: 1000,
  /** Refs per note the engine accepts. */
  memoryRefs: 10,
  taskChars: MAX_TASK_CHARS,
  refChars: 1000,
  /** Focus entries per request. */
  listItems: 20,
  /** The engine accepts shorter terms for maxify_compress focus than for paths in maxify_context. */
  compressFocusChars: 200,
  smallStringChars: 200,
  /**
   * Raw text passed inline to maxify_compress. Kept far below the SDK's 10 MiB
   * frame limit even when every character needs a six-byte JSON escape.
   */
  textChars: 1_000_000,
} as const;

/** Note text is one line: notes are rendered as list items, and a newline could forge structure. */
export const SINGLE_LINE_TEXT = /^[^\u0000-\u0008\u000A-\u001F\u007F\u0085\u2028\u2029]*$/;
