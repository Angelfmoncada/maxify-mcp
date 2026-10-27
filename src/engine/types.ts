/**
 * Engine facade contract shared by the MCP server, the CLI and the benchmarks.
 * Every method returns model-facing text that is already budgeted, plus
 * metadata that is NOT sent to the model (used for metrics, --json and tests).
 */
import type { CompressKindInput } from '../compress/types.js';
import type { Provenance } from '../core/types.js';

export const DEFAULT_CONTEXT_BUDGET = 6000;
export const MIN_BUDGET = 300;
/** Claude Code saves results over 50,000 characters to a file instead of showing them; stay well below. */
export const MAX_BUDGET = 12_000;
/** Hard cap on model-facing characters per tool result, independent of the token estimate. */
export const MAX_RESULT_CHARS = 45_000;

export type DetailLevel = 'map' | 'signature' | 'source';

export interface ContextRequest {
  /** Natural-language task; identifiers and paths in it are matched exactly. */
  task: string;
  /** Token budget for the whole returned text, including headers. Default DEFAULT_CONTEXT_BUDGET. */
  budget?: number;
  /** Paths, 'path#Symbol' or symbol names to prioritize. */
  focus?: string[];
  /** Highest detail level to use ('auto' = choose per item). Default 'auto'. */
  detail?: 'auto' | DetailLevel;
  /** Include related tests. Default true. */
  includeTests?: boolean;
  /** Continuation cursor from a previous incomplete result. */
  cursor?: string;
  /** Replace items already sent in this server session by a short reference. Default false. */
  delta?: boolean;
}

export interface SourceRequest {
  /** 'path', 'path:START-END', 'path:LINE', 'path#Qual.Name', 'Name', or 'blob:HASH'. */
  ref: string;
  /** Extra lines before/after a symbol or range. Default 0. */
  contextLines?: number;
  /** Page size in estimated tokens; longer sources are paginated explicitly, never cut silently. */
  maxTokens?: number;
}

export interface ImpactRequest {
  /** Paths or 'path#Symbol' refs that will change. */
  targets: string[];
  /** Transitive dependent depth. Default 2. */
  depth?: number;
  budget?: number;
}

export interface CompressRequest {
  /** Text to compress (only useful when it is not already in the model's context). */
  text?: string;
  /** File inside the repository (or Maxify state dir) to read and compress. */
  path?: string;
  /** Retrieve the exact original of a previous compression: 'blob:HASH' or 'HASH'. */
  ref?: string;
  /** With `ref`: 'START-END' line range of the original. */
  lines?: string;
  kind?: CompressKindInput;
  maxTokens?: number;
  /** Terms whose lines must be kept verbatim. */
  focus?: string[];
}

export type MemoryOp = 'add' | 'search' | 'list' | 'get' | 'update' | 'delete';

export interface MemoryRequest {
  op: MemoryOp;
  id?: string;
  /** Note text, at most 1000 characters. */
  text?: string;
  kind?: 'fact' | 'note' | 'decision';
  origin?: 'agent' | 'user';
  /** Paths or 'path#Symbol' the note is about; their content hashes are recorded for staleness. */
  refs?: string[];
  query?: string;
  limit?: number;
}

export interface StatsRequest {
  scope?: 'index' | 'session' | 'all';
}

export interface IndexOptions {
  /** Ignore stored hashes and re-parse everything. */
  full?: boolean;
}

export interface IndexSummary {
  generation: number;
  filesScanned: number;
  added: number;
  updated: number;
  removed: number;
  renamed: number;
  unchanged: number;
  skipped: number;
  durationMs: number;
  errors: string[];
}

/** One piece of evidence included in a result (metadata only, not sent to the model). */
export interface EvidenceItem {
  ref: string;
  path: string;
  startLine: number;
  endLine: number;
  symbol?: string;
  level: DetailLevel;
  provenance?: Provenance;
  /** Content hash prefix of the file the evidence was read from. */
  hash: string;
}

export interface ToolMeta {
  estTokens: number;
  complete: boolean;
  durationMs: number;
  cacheHit?: boolean;
  items?: EvidenceItem[];
  /** Refs the result mentions as omitted / expandable. */
  omitted?: string[];
  cursor?: string;
  [key: string]: unknown;
}

export interface ToolOutput {
  /** Model-facing text, already within budget. */
  text: string;
  isError?: boolean;
  meta: ToolMeta;
}

export interface EngineOptions {
  /** Repository root (validated; filesystem root and home directory are refused). */
  root: string;
  /** Exact state directory for this repository. Default: resolveStateDir(root). */
  stateDir?: string;
  /** Explicit config file path. Default: <root>/maxify.config.json if present. */
  configPath?: string;
  /** Run an incremental index on open. Default true. */
  autoIndex?: boolean;
}

export interface MaxifyEngine {
  readonly root: string;
  readonly stateDir: string;
  index(opts?: IndexOptions): Promise<IndexSummary>;
  context(req: ContextRequest): Promise<ToolOutput>;
  source(req: SourceRequest): Promise<ToolOutput>;
  impact(req: ImpactRequest): Promise<ToolOutput>;
  compress(req: CompressRequest): Promise<ToolOutput>;
  memory(req: MemoryRequest): Promise<ToolOutput>;
  stats(req?: StatsRequest): Promise<ToolOutput>;
  close(): void;
}
