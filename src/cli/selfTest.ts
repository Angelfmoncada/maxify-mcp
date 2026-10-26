/**
 * End-to-end MCP check used by `maxify doctor`: start the server as a child process speaking MCP over
 * stdio (the transport Claude Code uses; the `.mcp.json` entry itself is checked separately), list its
 * tools and call maxify_stats.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { TOOL_NAMES } from '../mcp/tools.js';

export interface SelfTestOptions {
  command: string;
  args: string[];
  /** Extra environment variables; the SDK's safe default environment is always included. */
  env?: Record<string, string>;
  cwd?: string;
  /** Per-step timeout. Default 30 s. */
  timeoutMs?: number;
}

export interface SelfTestResult {
  ok: boolean;
  message: string;
  toolNames: string[];
  durationMs: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const STDERR_TAIL_CHARS = 800;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function collectTail(stream: NodeJS.ReadableStream | null): () => string {
  let tail = '';
  stream?.on('data', (chunk: Buffer | string) => {
    tail = `${tail}${chunk.toString()}`.slice(-STDERR_TAIL_CHARS);
  });
  return () => tail.trim();
}

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .map((block: unknown) => (typeof block === 'object' && block !== null && 'text' in block ? String(block.text) : ''))
    .join('');
}

function missingTools(names: readonly string[]): string[] {
  return TOOL_NAMES.filter((name) => !names.includes(name));
}

async function exercise(client: Client, timeout: number): Promise<{ toolNames: string[]; message: string; ok: boolean }> {
  const { tools } = await client.listTools(undefined, { timeout });
  const toolNames = tools.map((tool) => tool.name).sort();
  const missing = missingTools(toolNames);
  if (toolNames.length !== TOOL_NAMES.length || missing.length > 0) {
    const detail = missing.length > 0 ? ` (missing ${missing.join(', ')})` : '';
    return { ok: false, toolNames, message: `expected ${TOOL_NAMES.length} tools, got ${toolNames.length}${detail}` };
  }
  const stats = await client.callTool({ name: 'maxify_stats', arguments: {} }, undefined, { timeout });
  if (stats.isError === true) {
    return { ok: false, toolNames, message: `maxify_stats returned an error: ${textOf(stats.content).slice(0, 300)}` };
  }
  return { ok: true, toolNames, message: `${toolNames.length} tools listed, maxify_stats answered` };
}

export async function runMcpSelfTest(opts: SelfTestOptions): Promise<SelfTestResult> {
  const started = Date.now();
  const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const transport = new StdioClientTransport({
    command: opts.command,
    args: opts.args,
    env: { ...getDefaultEnvironment(), ...opts.env },
    stderr: 'pipe',
    ...(opts.cwd === undefined ? {} : { cwd: opts.cwd }),
  });
  const stderrTail = collectTail(transport.stderr as NodeJS.ReadableStream | null);
  const client = new Client({ name: 'maxify-doctor', version: '0.0.0' });
  try {
    await client.connect(transport, { timeout });
    const outcome = await exercise(client, timeout);
    return { ...outcome, durationMs: Date.now() - started };
  } catch (error: unknown) {
    const logged = stderrTail();
    const suffix = logged.length > 0 ? `; server stderr: ${logged}` : '';
    return { ok: false, toolNames: [], message: `${errorMessage(error)}${suffix}`, durationMs: Date.now() - started };
  } finally {
    await client.close().catch(() => undefined);
  }
}
