/**
 * Maps engine output and failures to MCP tool results.
 *
 * Results are `{ content: [{ type: 'text', text }], isError? }` ONLY. Maxify
 * deliberately declares no outputSchema and never sets structuredContent:
 * clients forward both the text block and the structured block to the model,
 * so a structured twin of the same data would double its token cost. Metadata
 * (ToolOutput.meta) stays server side for metrics, `--json` and tests.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { isMaxifyError } from '../core/errors.js';
import { log } from '../core/log.js';
import { MAX_RESULT_CHARS, type ToolOutput } from '../engine/types.js';

export const INTERNAL_ERROR_TEXT = 'internal error (details in server log)';
/** Claude Code cuts error text far above this (~11,000 chars); error messages must stay short. */
export const ERROR_TEXT_MAX_CHARS = 4000;
const EMPTY_RESULT_TEXT = '(no output)';
/** Footers (continuation pointers, refs to expand omissions) sit at the end, so a cut keeps this much of it. */
const TAIL_MAX_CHARS = 1500;
/** How far a cut may move to land on a line boundary. */
const LINE_SNAP_CHARS = 200;

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** Largest end <= `end` that keeps the head intact: not inside a surrogate pair, preferably at a line end. */
function headEndFor(text: string, end: number): number {
  const safe = end > 0 && isHighSurrogate(text.charCodeAt(end - 1)) ? end - 1 : end;
  const newline = text.lastIndexOf('\n', safe);
  return newline > 0 && safe - newline < LINE_SNAP_CHARS ? newline : safe;
}

/** Smallest start >= `start` that keeps the tail intact: not inside a surrogate pair, preferably at a line start. */
function tailStartFor(text: string, start: number): number {
  const safe = start < text.length && isLowSurrogate(text.charCodeAt(start)) ? start + 1 : start;
  const newline = text.indexOf('\n', safe);
  return newline >= 0 && newline - safe < LINE_SNAP_CHARS ? newline + 1 : safe;
}

/**
 * Bound `text` to about `max` characters by omitting the middle, and say so where it happened.
 * Head and tail survive: the head has the answer, the tail the footer that says how to get more.
 */
export function clampText(text: string, max: number, what: string): string {
  if (text.length <= max) return text;
  const tailLength = Math.min(TAIL_MAX_CHARS, Math.floor(max / 4));
  const headEnd = headEndFor(text, max - tailLength);
  const tailStart = tailStartFor(text, text.length - tailLength);
  const omitted = tailStart - headEnd;
  const marker = `\n[maxify: ${omitted} characters omitted here (${what} limit ${max}). Ask for less: lower budget or max_tokens, or a narrower ref.]\n`;
  return `${text.slice(0, headEnd)}${marker}${text.slice(tailStart)}`;
}

export function textResult(text: string, isError: boolean): CallToolResult {
  const body = text.trim().length === 0 ? EMPTY_RESULT_TEXT : text;
  const clamped = isError ? clampText(body, ERROR_TEXT_MAX_CHARS, 'error text') : clampText(body, MAX_RESULT_CHARS, 'result');
  return isError
    ? { content: [{ type: 'text', text: clamped }], isError: true }
    : { content: [{ type: 'text', text: clamped }] };
}

export function toToolResult(output: ToolOutput): CallToolResult {
  return textResult(output.text, output.isError === true);
}

function describeFailure(error: unknown): string {
  if (error instanceof Error) return error.stack ?? `${error.name}: ${error.message}`;
  return String(error);
}

/** Run an engine call and convert every outcome (output, expected error, bug) to a tool result. */
export async function runTool(tool: string, call: () => Promise<ToolOutput>): Promise<CallToolResult> {
  try {
    return toToolResult(await call());
  } catch (error: unknown) {
    if (isMaxifyError(error)) {
      if (error.code === 'INTERNAL') log.error(`${tool}: ${describeFailure(error)}`);
      return textResult(error.message, true);
    }
    log.error(`${tool}: unexpected error: ${describeFailure(error)}`);
    return textResult(INTERNAL_ERROR_TEXT, true);
  }
}
