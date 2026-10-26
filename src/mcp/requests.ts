/** Maps validated snake_case tool arguments to the engine's camelCase requests. */
import type { z } from 'zod';
import type {
  CompressRequest,
  ContextRequest,
  ImpactRequest,
  MemoryRequest,
  SourceRequest,
  StatsRequest,
} from '../engine/types.js';
import type { compressShape, contextShape, impactShape, memoryShape, sourceShape, statsShape } from './tools.js';

type ArgsOf<S extends z.ZodRawShape> = z.output<z.ZodObject<S>>;

export type ContextArgs = ArgsOf<typeof contextShape>;
export type SourceArgs = ArgsOf<typeof sourceShape>;
export type ImpactArgs = ArgsOf<typeof impactShape>;
export type CompressArgs = ArgsOf<typeof compressShape>;
export type MemoryArgs = ArgsOf<typeof memoryShape>;
export type StatsArgs = ArgsOf<typeof statsShape>;

/** Drop keys whose value is undefined so the engine only sees what the caller actually sent. */
export function definedOnly<T extends object>(request: T): T {
  return Object.fromEntries(Object.entries(request).filter(([, value]) => value !== undefined)) as T;
}

export function toContextRequest(args: ContextArgs): ContextRequest {
  return definedOnly<ContextRequest>({
    task: args.task,
    budget: args.budget,
    focus: args.focus,
    detail: args.detail,
    includeTests: args.include_tests,
    cursor: args.cursor,
    delta: args.delta,
  });
}

export function toSourceRequest(args: SourceArgs): SourceRequest {
  return definedOnly<SourceRequest>({
    ref: args.ref,
    contextLines: args.context_lines,
    maxTokens: args.max_tokens,
  });
}

export function toImpactRequest(args: ImpactArgs): ImpactRequest {
  return definedOnly<ImpactRequest>({ targets: args.targets, depth: args.depth, budget: args.budget });
}

export function toCompressRequest(args: CompressArgs): CompressRequest {
  return definedOnly<CompressRequest>({
    path: args.path,
    text: args.text,
    ref: args.ref,
    lines: args.lines,
    kind: args.kind,
    maxTokens: args.max_tokens,
    focus: args.focus,
  });
}

/**
 * Provenance is assigned here, never taken from the model: whatever a prompt-injected model
 * might claim, a note it adds or rewrites through MCP is agent-authored. `user` notes can
 * only be created from the CLI.
 */
export function toMemoryRequest(args: MemoryArgs): MemoryRequest {
  const writes = args.op === 'add' || args.op === 'update';
  return definedOnly<MemoryRequest>({
    op: args.op,
    id: args.id,
    text: args.text,
    kind: args.kind,
    origin: writes ? 'agent' : undefined,
    refs: args.refs,
    query: args.query,
    limit: args.limit,
  });
}

export function toStatsRequest(args: StatsArgs): StatsRequest {
  return definedOnly<StatsRequest>({ scope: args.scope });
}
