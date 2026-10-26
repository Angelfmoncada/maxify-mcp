import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { vi } from 'vitest';
import type { IndexSummary, MaxifyEngine, ToolOutput } from '../../src/engine/types.js';
import { createMcpServer } from '../../src/mcp/server.js';

export interface RecordedCall {
  method: string;
  request: unknown;
}

export interface FakeEngine {
  engine: MaxifyEngine;
  calls: RecordedCall[];
}

export const EMPTY_SUMMARY: IndexSummary = {
  generation: 1,
  filesScanned: 3,
  added: 1,
  updated: 1,
  removed: 0,
  renamed: 0,
  unchanged: 1,
  skipped: 0,
  durationMs: 5,
  errors: [],
};

export function okOutput(text: string, extra: Partial<ToolOutput> = {}): ToolOutput {
  return { text, meta: { estTokens: 1, complete: true, durationMs: 0 }, ...extra };
}

/** Test double implementing MaxifyEngine; every call is recorded and answers "<method> ok". */
export function createFakeEngine(overrides: Partial<MaxifyEngine> = {}): FakeEngine {
  const calls: RecordedCall[] = [];
  const reply =
    (method: string) =>
    async (request?: unknown): Promise<ToolOutput> => {
      calls.push({ method, request });
      return okOutput(`${method} ok`);
    };
  const engine: MaxifyEngine = {
    root: '/repo',
    stateDir: '/state',
    index: async () => EMPTY_SUMMARY,
    context: reply('context'),
    source: reply('source'),
    impact: reply('impact'),
    compress: reply('compress'),
    memory: reply('memory'),
    stats: reply('stats'),
    close: vi.fn(),
    ...overrides,
  };
  return { engine, calls };
}

export interface Connected {
  client: Client;
  server: McpServer;
  close(): Promise<void>;
}

export async function connect(engine: MaxifyEngine, cliCommand = 'maxify'): Promise<Connected> {
  const server = createMcpServer(engine, { version: '1.2.3', cliCommand });
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    server,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

export interface TextResult {
  text: string;
  isError: boolean;
  keys: string[];
  contentTypes: string[];
}

/** Call a tool and flatten the result for assertions. */
export async function callText(client: Client, name: string, args: Record<string, unknown>): Promise<TextResult> {
  const result = await client.callTool({ name, arguments: args });
  const content = Array.isArray(result.content) ? result.content : [];
  const text = content
    .map((block) => (block !== null && typeof block === 'object' && 'text' in block ? String(block.text) : ''))
    .join('');
  return {
    text,
    isError: result.isError === true,
    keys: Object.keys(result).sort(),
    contentTypes: content.map((block) => (block !== null && typeof block === 'object' && 'type' in block ? String(block.type) : '')),
  };
}
