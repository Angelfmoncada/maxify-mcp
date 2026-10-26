/**
 * Everything the CLI needs from its environment, injectable so commands can
 * be tested without real stdio, a real engine or a real MCP server process.
 */
import { fileURLToPath } from 'node:url';
import type { EngineOptions, MaxifyEngine } from '../engine/types.js';
import { MAXIFY_VERSION } from '../version.js';
import type { OfflineBenchOptions, OfflineBenchResult } from '../bench/offline.js';
import type { ServeHandle, ServeStdioOptions } from '../mcp/stdio.js';
import type { SelfTestOptions, SelfTestResult } from './selfTest.js';
import { readStreamText, MAX_INPUT_BYTES } from './input.js';

export interface CliIo {
  /** Write to stdout (command output). */
  out(text: string): void;
  /** Write to stderr (diagnostics and errors). */
  err(text: string): void;
  readonly stdinIsTTY: boolean;
  /** Read all of stdin as text. */
  readStdin(): Promise<string>;
}

export interface CliDeps {
  io: CliIo;
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Package version. */
  version: string;
  /** Absolute path of the CLI entry point (dist/cli.js). */
  cliPath: string;
  openEngine(opts: EngineOptions): Promise<MaxifyEngine>;
  serve(engine: MaxifyEngine, opts: ServeStdioOptions): Promise<ServeHandle>;
  runOfflineBench(opts: OfflineBenchOptions): Promise<OfflineBenchResult>;
  runMcpSelfTest(opts: SelfTestOptions): Promise<SelfTestResult>;
}

/**
 * Absolute path of dist/cli.js, resolved from this module. From a source checkout that runs without a
 * build (src/cli/) it points at a src/cli.js that does not exist; `doctor` reports that case.
 */
export function cliEntryPath(): string {
  return fileURLToPath(new URL('../cli.js', import.meta.url));
}

export function createProcessIo(): CliIo {
  return {
    out: (text) => void process.stdout.write(text),
    err: (text) => void process.stderr.write(text),
    stdinIsTTY: process.stdin.isTTY === true,
    readStdin: () => readStreamText(process.stdin, MAX_INPUT_BYTES),
  };
}

/** Real dependencies. Heavy modules are imported on demand so `maxify --help` stays fast. */
export function createDefaultDeps(): CliDeps {
  return {
    io: createProcessIo(),
    cwd: process.cwd(),
    env: process.env,
    version: MAXIFY_VERSION,
    cliPath: cliEntryPath(),
    openEngine: async (opts) => (await import('../engine/engine.js')).openEngine(opts),
    serve: async (engine, opts) => (await import('../mcp/stdio.js')).serveStdio(engine, opts),
    runOfflineBench: async (opts) => (await import('../bench/offline.js')).runOfflineBench(opts),
    runMcpSelfTest: async (opts) => (await import('./selfTest.js')).runMcpSelfTest(opts),
  };
}
