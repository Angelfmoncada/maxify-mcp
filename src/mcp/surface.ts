/**
 * Measures the context cost of the MCP surface as a real client sees it:
 * a server over a no-op engine is connected to an SDK client through an
 * in-memory transport, then tools/list and the initialize instructions are
 * serialized and estimated.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { estimateTokens } from '../core/tokens.js';
import type { IndexSummary, MaxifyEngine, ToolOutput } from '../engine/types.js';
import { createMcpServer } from './server.js';
import { ALWAYS_LOAD_TOOLS, type ToolName } from './tools.js';

export interface ToolSurfaceEntry {
  name: string;
  /** Estimated tokens of the tool definition JSON (name, description, inputSchema, annotations). */
  tokens: number;
  /** True when the server asks clients to keep this tool's schema loaded. */
  alwaysLoad: boolean;
}

export interface ToolSurface {
  instructionsTokens: number;
  tools: ToolSurfaceEntry[];
  /** instructions + every tool definition (clients that load all schemas). */
  totalTokens: number;
  /**
   * Instructions + alwaysLoad tool definitions + the names of the other tools:
   * what Claude Code loads up front when it defers MCP tool schemas.
   */
  upfrontTokens: number;
}

export interface SurfaceOptions {
  cliCommand?: string;
  version?: string;
}

const EMPTY_OUTPUT: ToolOutput = { text: '', meta: { estTokens: 0, complete: true, durationMs: 0 } };
const EMPTY_SUMMARY: IndexSummary = {
  generation: 0,
  filesScanned: 0,
  added: 0,
  updated: 0,
  removed: 0,
  renamed: 0,
  unchanged: 0,
  skipped: 0,
  durationMs: 0,
  errors: [],
};

/** Engine that does nothing; enough to list tools. */
export function createNoopEngine(): MaxifyEngine {
  const output = async (): Promise<ToolOutput> => EMPTY_OUTPUT;
  return {
    root: '',
    stateDir: '',
    index: async () => EMPTY_SUMMARY,
    context: output,
    source: output,
    impact: output,
    compress: output,
    memory: output,
    stats: output,
    close: () => undefined,
  };
}

function isAlwaysLoad(name: string): boolean {
  return ALWAYS_LOAD_TOOLS.has(name as ToolName);
}

export async function describeToolSurface(opts: SurfaceOptions = {}): Promise<ToolSurface> {
  const server = createMcpServer(createNoopEngine(), {
    version: opts.version ?? '0.0.0',
    cliCommand: opts.cliCommand ?? 'maxify',
  });
  const client = new Client({ name: 'maxify-surface', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const { tools } = await client.listTools();
    const instructionsTokens = estimateTokens(client.getInstructions() ?? '');
    const entries = tools.map(
      (tool): ToolSurfaceEntry => ({
        name: tool.name,
        tokens: estimateTokens(
          JSON.stringify({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
            annotations: tool.annotations,
          }),
        ),
        alwaysLoad: isAlwaysLoad(tool.name),
      }),
    );
    const toolTokens = entries.reduce((sum, entry) => sum + entry.tokens, 0);
    const upfrontToolTokens = entries.reduce(
      (sum, entry) => sum + (entry.alwaysLoad ? entry.tokens : estimateTokens(entry.name)),
      0,
    );
    return {
      instructionsTokens,
      tools: entries,
      totalTokens: instructionsTokens + toolTokens,
      upfrontTokens: instructionsTokens + upfrontToolTokens,
    };
  } finally {
    await client.close();
    await server.close();
  }
}

/** One-line human summary used by `maxify stats` and `maxify doctor`. */
export function formatSurface(surface: ToolSurface): string {
  const perTool = surface.tools.map((tool) => `${tool.name} ${tool.tokens}`).join(', ');
  return (
    `tool surface: ~${surface.totalTokens} est. tokens if all schemas load ` +
    `(instructions ${surface.instructionsTokens}; ${perTool}); ` +
    `~${surface.upfrontTokens} upfront when the client defers non-essential tools`
  );
}
