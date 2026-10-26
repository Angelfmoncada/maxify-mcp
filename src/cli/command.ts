/** Shared types and helpers for CLI commands. */
import type { ParseArgsOptionsConfig } from 'node:util';
import { log } from '../core/log.js';
import type { EngineOptions, MaxifyEngine, ToolOutput } from '../engine/types.js';
import type { GlobalOptions, OptionValues } from './args.js';
import type { CliDeps } from './deps.js';
import { locateRepo, type RepoLocation } from './root.js';

export interface CommandCall {
  globals: GlobalOptions;
  values: OptionValues;
  positionals: string[];
  deps: CliDeps;
}

export interface OptionDoc {
  flag: string;
  description: string;
}

export interface CommandSpec {
  name: string;
  summary: string;
  /** Usage after "maxify ", e.g. "query <task...> [--budget N]". */
  usage: string;
  /** Extra help paragraphs. */
  details?: readonly string[];
  /** Command-specific parseArgs options (global options are always accepted). */
  options: ParseArgsOptionsConfig;
  optionDocs: readonly OptionDoc[];
  run(call: CommandCall): Promise<number>;
}

export interface CommandResult {
  text: string;
  meta: Record<string, unknown>;
  isError?: boolean;
}

function withNewline(text: string): string {
  return text.endsWith('\n') ? text : `${text}\n`;
}

/**
 * Print a result. One rule for every outcome: success goes to stdout (`{text, meta}` JSON with
 * --json, plain text otherwise); failure is plain text on stderr with exit code 1, never JSON.
 */
export function printResult(call: CommandCall, result: CommandResult): number {
  const { io } = call.deps;
  if (result.isError) {
    io.err(withNewline(result.text));
    return 1;
  }
  io.out(call.globals.json ? `${JSON.stringify({ text: result.text, meta: result.meta })}\n` : withNewline(result.text));
  return 0;
}

export function printToolOutput(call: CommandCall, output: ToolOutput): number {
  return printResult(call, {
    text: output.text,
    meta: output.meta,
    ...(output.isError === true ? { isError: true } : {}),
  });
}

/** Progress and informational lines go to stderr and respect --quiet. */
export function info(call: CommandCall, message: string): void {
  if (!call.globals.quiet) call.deps.io.err(`[maxify] ${message}\n`);
}

export function locate(call: CommandCall): RepoLocation {
  return locateRepo(call.globals, call.deps.env, call.deps.cwd);
}

export function engineOptions(location: RepoLocation, autoIndex?: boolean): EngineOptions {
  return {
    root: location.root,
    ...(location.stateDirOverride === undefined ? {} : { stateDir: location.stateDirOverride }),
    ...(location.configPath === undefined ? {} : { configPath: location.configPath }),
    ...(autoIndex === undefined ? {} : { autoIndex }),
  };
}

/**
 * Open the engine for one command and always close it. `autoIndex` undefined keeps the
 * engine default (true). Pass `location` when the caller already resolved it.
 */
export async function withEngine<T>(
  call: CommandCall,
  autoIndex: boolean | undefined,
  action: (engine: MaxifyEngine, location: RepoLocation) => Promise<T>,
  location: RepoLocation = locate(call),
): Promise<T> {
  const engine = await call.deps.openEngine(engineOptions(location, autoIndex));
  try {
    return await action(engine, location);
  } finally {
    closeQuietly(engine);
  }
}

/** Close the engine; a failure to close must not hide the command's own outcome. */
export function closeQuietly(engine: MaxifyEngine): void {
  try {
    engine.close();
  } catch (error: unknown) {
    log.warn(`closing the engine failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
