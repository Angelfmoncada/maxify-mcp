/**
 * The Maxify MCP server: exactly six tools over a MaxifyEngine.
 *
 * Input is validated by zod (the SDK turns a validation failure into an
 * isError result before any handler runs). Handlers only translate arguments
 * and results; all behavior lives in the engine.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { MaxifyEngine } from '../engine/types.js';
import { buildInstructions } from './instructions.js';
import {
  toCompressRequest,
  toContextRequest,
  toImpactRequest,
  toMemoryRequest,
  toSourceRequest,
  toStatsRequest,
} from './requests.js';
import { runTool } from './results.js';
import {
  ALWAYS_LOAD_META,
  ALWAYS_LOAD_TOOLS,
  ANNOTATIONS,
  DESCRIPTIONS,
  compressShape,
  contextShape,
  impactShape,
  memoryShape,
  sourceShape,
  statsShape,
  type ToolName,
} from './tools.js';

export interface McpServerOptions {
  /** Server version reported to clients. */
  version: string;
  /** Command used in the instructions to pipe command output into `compress`. */
  cliCommand: string;
}

export const SERVER_NAME = 'maxify';

/** Largest number of array elements plus object members one tool call may carry (inputs are small). */
const MAX_TOOL_INPUT_ELEMENTS = 500;

function toolConfig(name: ToolName): {
  description: string;
  annotations: (typeof ANNOTATIONS)[ToolName];
  _meta?: Record<string, unknown>;
} {
  return {
    description: DESCRIPTIONS[name],
    annotations: ANNOTATIONS[name],
    ...(ALWAYS_LOAD_TOOLS.has(name) ? { _meta: { ...ALWAYS_LOAD_META } } : {}),
  };
}

function registerTools(server: McpServer, engine: MaxifyEngine): void {
  server.registerTool(
    'maxify_context',
    { ...toolConfig('maxify_context'), inputSchema: contextShape },
    (args) => runTool('maxify_context', () => engine.context(toContextRequest(args))),
  );
  server.registerTool(
    'maxify_source',
    { ...toolConfig('maxify_source'), inputSchema: sourceShape },
    (args) => runTool('maxify_source', () => engine.source(toSourceRequest(args))),
  );
  server.registerTool(
    'maxify_impact',
    { ...toolConfig('maxify_impact'), inputSchema: impactShape },
    (args) => runTool('maxify_impact', () => engine.impact(toImpactRequest(args))),
  );
  server.registerTool(
    'maxify_compress',
    { ...toolConfig('maxify_compress'), inputSchema: compressShape },
    (args) => runTool('maxify_compress', () => engine.compress(toCompressRequest(args))),
  );
  server.registerTool(
    'maxify_memory',
    { ...toolConfig('maxify_memory'), inputSchema: memoryShape },
    (args) => runTool('maxify_memory', () => engine.memory(toMemoryRequest(args))),
  );
  server.registerTool(
    'maxify_stats',
    { ...toolConfig('maxify_stats'), inputSchema: statsShape },
    (args) => runTool('maxify_stats', () => engine.stats(toStatsRequest(args))),
  );
}

/** Build the server; the caller connects a transport. */
export function createMcpServer(engine: MaxifyEngine, opts: McpServerOptions): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: opts.version },
    { instructions: buildInstructions(opts.cliCommand), maxToolInputElements: MAX_TOOL_INPUT_ELEMENTS },
  );
  registerTools(server, engine);
  return server;
}
