import { estimateTokens } from '../core/tokens.js';
import { fitLines, type FitResult } from './fit.js';
import { BASE_LABELS, NEVER, R_BLANK, R_CRITICAL, type Critical, type LinePlan, type ReasonLabel } from './plan.js';
import type { CompressKind, TransformClass } from './types.js';

/** What every kind compressor returns to the orchestrator (index.ts). */
export interface KindOutput {
  kind: CompressKind;
  text: string;
  transform: TransformClass;
  /** Every distinct critical item found (verified against `text` afterwards). */
  critical: Critical[];
  omittedLines: number;
  /** 1-based lines of critical items deliberately left out to fit the budget (listed in `text`). */
  omittedCritical: number[];
  notes: string[];
}

export interface KindContext {
  /** Hard budget (critical content beyond it is listed, never silently dropped). */
  maxTokens: number;
  /** Fill target for optional content. */
  target: number;
  focus: readonly string[];
  /** Marker prefix that no cleaned line starts with. */
  markerFor(lines: readonly string[]): string;
}

export function tokens(text: string): number {
  return estimateTokens(text);
}

/** Lines of the FitResult's critical items that are absent from its text (deliberate omissions). */
export function omittedCriticalLines(fit: FitResult): number[] {
  if (fit.omittedCritical === 0) return [];
  const present = new Set(fit.text.split('\n'));
  return fit.critical.filter((c) => !present.has(c.text)).map((c) => c.line);
}

/** Converts a line-plan fit into a kind output. */
export function fromFit(kind: CompressKind, fit: FitResult): KindOutput {
  const transform: TransformClass = fit.formatOnly ? 'format' : fit.lossy ? 'summary' : 'selection';
  return {
    kind,
    text: fit.text,
    transform,
    critical: fit.critical,
    omittedLines: fit.omittedLines,
    omittedCritical: omittedCriticalLines(fit),
    notes: fit.notes,
  };
}

/**
 * Last resort for structured kinds whose most compact layout plus critical
 * lines exceeds the budget: show critical lines only (with line-located
 * omission markers), via the shared line fitter.
 */
export function criticalOnly(
  kind: CompressKind,
  lines: readonly string[],
  crit: Uint8Array,
  label: ReasonLabel,
  summary: readonly string[],
  ctx: KindContext,
  marker: string,
): KindOutput {
  const n = lines.length;
  const reason = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    reason[i] = (crit[i] ?? 0) > 0 ? R_CRITICAL : (lines[i] ?? '').trim() === '' ? R_BLANK : BASE_LABELS.length;
  }
  const plan: LinePlan = {
    lines,
    crit,
    tier: new Uint8Array(n).fill(NEVER),
    order: new Float64Array(n),
    reason,
    labels: [...BASE_LABELS, label],
    groupOf: new Int32Array(n).fill(-1),
    groups: [],
    summarize: () => [...summary],
    lossy: false,
    notes: [`${kind}: compact layout did not fit; showing critical lines only`],
  };
  const fit = fitLines(plan, { maxTokens: ctx.maxTokens, target: ctx.maxTokens, marker });
  return { ...fromFit(kind, fit), transform: 'selection' };
}
