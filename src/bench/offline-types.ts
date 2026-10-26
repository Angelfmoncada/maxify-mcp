/** Data model of the offline benchmark: task specs, per-run records and the report. */
import type { Level } from './refs.js';

export const TASK_CATEGORIES = [
  'diagnosis',
  'multi-module',
  'contract-update',
  'test-search',
  'post-edit',
  'small',
  'uncertainty',
  'decoy',
] as const;

export type TaskCategory = (typeof TASK_CATEGORIES)[number];

export interface RequirementSpec {
  /** 'path', 'path#Qual.Name' or 'path:START-END' (see refs.ts). */
  ref: string;
  /** Minimum detail level the evidence must reach: source > signature > map. */
  level: Level;
  /** Text that must occur inside a range ref; guards line-number refs against fixture drift. */
  anchor?: string;
}

export interface EditSpec {
  file: string;
  /** Must occur exactly once in the file. */
  find: string;
  replace: string;
}

export interface OfflineTaskSpec {
  id: string;
  category: TaskCategory;
  prompt: string;
  required: RequirementSpec[];
  /** Decoys: a hit means the evidence presents an unrelated file or symbol as relevant. */
  forbidden: string[];
  /** Applied to the fixture copy (then re-indexed) before the task is queried. */
  edit?: EditSpec;
  /** Substrings that must NOT appear in the returned text (stale code after an edit). */
  forbiddenText?: string[];
  /** Case-insensitive regular expressions of which at least one must match the returned text. */
  requireText?: string[];
  notes: string;
}

/** One local tool call and its estimated token cost. */
export interface CallCost {
  label: string;
  argTokens: number;
  resultTokens: number;
  /** argTokens + resultTokens + per-call overhead. */
  tokens: number;
}

export interface FollowUpRecord {
  ref: string;
  /** maxify_source for signature/source gaps, a focused maxify_context for "map" gaps. */
  tool: 'maxify_source' | 'maxify_context';
  ok: boolean;
  tokens: number;
  error?: string;
}

export interface MaxifyTaskRun {
  budget: number;
  firstCall: CallCost & {
    /** meta.estTokens reported by the engine (cross-check of our own estimate). */
    engineEstTokens: number | null;
    latencyMs: number;
    complete: boolean;
    /** Our estimate of the returned text exceeds the requested budget. */
    overBudget: boolean;
    itemCount: number;
    omittedCount: number;
    error?: string;
  };
  recallFirst: number;
  missedFirst: string[];
  followUps: FollowUpRecord[];
  followUpTokens: number;
  /** First call plus follow-ups. */
  totalTokens: number;
  totalCalls: number;
  recallFinal: number;
  missedFinal: string[];
  /** Forbidden refs present in the selected evidence at any level (first call). */
  forbiddenHits: string[];
  /** The subset of forbiddenHits shown at signature or source level, i.e. presented as relevant code. */
  forbiddenHitsStrong: string[];
  /** Forbidden paths that merely appear somewhere in the returned text. */
  forbiddenMentions: string[];
  forbiddenTextHits: string[];
  /** Undefined when the task has no requireText. */
  requireTextOk?: boolean;
  /** Post-edit tasks: did the re-index report the edited file as changed. */
  editDetected?: boolean;
}

export interface SimRun {
  strategy: 'grep-read-files' | 'grep-read-ranges';
  keywords: string[];
  calls: number;
  tokens: number;
  perCall: CallCost[];
  /** Files fully read or line windows read, as 'path' or 'path:START-END'. */
  reads: string[];
  recall: number;
  missed: string[];
  forbiddenRead: string[];
}

export interface TaskResult {
  id: string;
  category: TaskCategory;
  prompt: string;
  requirementCount: number;
  requirements: Array<{ ref: string; level: Level }>;
  simA: SimRun;
  simB: SimRun;
  /** Per budget; empty when the engine was unavailable. */
  maxify: MaxifyTaskRun[];
}

export interface IndexTimings {
  coldMs: number;
  coldFiles: number;
  coldErrors: number;
  incrementalMs: number;
  incrementalChanged: number;
  incrementalUnchanged: number;
}

export interface EngineStatus {
  available: boolean;
  /** Why the Maxify columns are missing, when unavailable. */
  reason?: string;
}

export interface OfflineReport {
  generatedAt: string;
  notice: string;
  fixture: { name: string; files: number; lines: number };
  budgets: number[];
  engine: EngineStatus;
  index: IndexTimings | null;
  tasks: TaskResult[];
  constants: { perCallOverheadTokens: number; maxKeywords: number; readFileCount: number; windowRadius: number; maxWindows: number };
}
