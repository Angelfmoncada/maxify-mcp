/**
 * Serves the MCP server over stdio.
 *
 * stdout carries ONLY JSON-RPC frames, so console output is redirected to
 * stderr for the lifetime of the server. Claude Code stops a stdio server by
 * closing its stdin and may kill the process tree ~300 ms later (Windows), so
 * shutdown is synchronous: close the engine, then exit.
 */
import type { Readable, Writable } from 'node:stream';
import { Console } from 'node:console';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { log } from '../core/log.js';
import type { MaxifyEngine } from '../engine/types.js';
import { createMcpServer, type McpServerOptions } from './server.js';

export interface ServeStdioOptions extends McpServerOptions {
  /** Run an incremental index in the background after connecting. Default true. */
  index?: boolean;
  /** Test seams; default to the process streams, `process.exit` and `process`. */
  stdin?: Readable;
  stdout?: Writable;
  exit?: (code: number) => void;
  signals?: Pick<NodeJS.EventEmitter, 'on'>;
  redirectConsole?: boolean;
}

export interface ServeHandle {
  server: McpServer;
  /** Close the engine and exit. Safe to call more than once. */
  shutdown(reason: string, code?: number): void;
  /** Resolves once shutdown has started. */
  closed: Promise<void>;
}

/** Console methods that write to stdout; every one of them would corrupt the JSON-RPC stream. */
const STDOUT_METHODS = ['log', 'info', 'debug', 'dir', 'dirxml', 'table'] as const;

/**
 * Send every stdout-writing console method to `target` (default stderr). Returns a
 * function that restores the originals.
 */
export function redirectConsoleToStderr(target: Writable = process.stderr): () => void {
  const sink = new Console({ stdout: target, stderr: target });
  const originals = STDOUT_METHODS.map((method) => console[method]);
  for (const method of STDOUT_METHODS) console[method] = sink[method].bind(sink);
  return () => {
    STDOUT_METHODS.forEach((method, index) => {
      const original = originals[index];
      if (original !== undefined) console[method] = original;
    });
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Fire-and-forget index, started after the handshake so connecting never waits for it. It never
 * throws. Tool calls that need the index may still queue behind it if the engine serializes work.
 */
function startBackgroundIndex(engine: MaxifyEngine): void {
  void (async () => {
    try {
      const summary = await engine.index();
      log.info(
        `index ready: ${summary.unchanged + summary.added + summary.updated} files ` +
          `(+${summary.added} ~${summary.updated} -${summary.removed}) in ${summary.durationMs} ms`,
      );
      for (const message of summary.errors.slice(0, 5)) log.warn(`index: ${message}`);
    } catch (error: unknown) {
      log.error(`initial index failed: ${errorMessage(error)}`);
    }
  })();
}

export async function serveStdio(engine: MaxifyEngine, opts: ServeStdioOptions): Promise<ServeHandle> {
  const stdin = opts.stdin ?? process.stdin;
  const stdout = opts.stdout ?? process.stdout;
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  const signals = opts.signals ?? process;
  const restoreConsole = opts.redirectConsole === false ? () => undefined : redirectConsoleToStderr();

  let resolveClosed: () => void = () => undefined;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  let stopping = false;
  const shutdown = (reason: string, code = 0): void => {
    if (stopping) return;
    stopping = true;
    log.debug(`shutting down: ${reason}`);
    try {
      engine.close();
    } catch (error: unknown) {
      log.error(`closing the engine failed: ${errorMessage(error)}`);
    }
    restoreConsole();
    resolveClosed();
    exit(code);
  };

  const server = createMcpServer(engine, opts);
  const transport = new StdioServerTransport(stdin, stdout);
  // Nothing in Maxify closes the transport; the SDK does it only after a fatal framing error
  // (for example an oversized message), so this is a failure exit, not a clean one.
  server.server.onclose = () => shutdown('transport closed', 1);
  server.server.onerror = (error) => log.error(`transport error: ${errorMessage(error)}`);

  stdin.once('end', () => shutdown('stdin ended'));
  stdin.once('close', () => shutdown('stdin closed'));
  stdout.once('error', (error) => shutdown(`stdout error: ${errorMessage(error)}`, 1));
  signals.on('SIGINT', () => shutdown('SIGINT'));
  signals.on('SIGTERM', () => shutdown('SIGTERM'));

  await server.connect(transport);
  log.info(`serving ${engine.root} (state: ${engine.stateDir})`);
  if (opts.index !== false) startBackgroundIndex(engine);
  return { server, shutdown, closed };
}
