/**
 * Typed access to the plain-ESM agent harness (bench/agent/lib/*.mjs) from TypeScript tests.
 * The harness is deliberately build-free JavaScript, so its contracts are restated here.
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const AGENT_DIR = path.join(REPO_ROOT, 'bench', 'agent');
export const FIXTURE_DIR = path.join(REPO_ROOT, 'bench', 'fixtures', 'taskboard');

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}

export interface InitInfo {
  sessionId: string | null;
  model: string | null;
  tools: string[];
  mcpServers: Array<{ name: string; status: string }>;
  plugins: string[];
  slashCommands: string[];
  skills: string[];
  agents: string[];
  apiKeySource: string | null;
}

export interface ResultInfo {
  subtype: string;
  isError: boolean;
  durationMs: number;
  durationApiMs: number;
  numTurns: number;
  totalCostUsd: number;
  usage: Usage;
  permissionDenials: Array<{ toolName: string }>;
  text: string;
}

export interface StreamSummary {
  init: InitInfo | null;
  result: ResultInfo | null;
  hasResult: boolean;
  usage: Usage;
  usageSource: 'result' | 'messages';
  messageUsageTotals: Usage;
  assistantMessages: number;
  subagentMessages: number;
  firstTurnContextTokens: number | null;
  toolCalls: { total: number; mcp: number; builtin: number; byName: Record<string, number>; byServer: Record<string, number>; sequence: string[] };
  toolResults: { count: number; chars: number; errors: number };
}

export interface StreamModule {
  parseJsonLines(text: string): { events: Array<Record<string, unknown>>; invalidLines: number };
  summarizeStream(events: Array<Record<string, unknown>>): StreamSummary;
  normalizeUsage(usage: unknown): Usage;
  totalTokens(usage: Usage): number;
  mcpServerOf(toolName: string): string | null;
}

export interface Classification {
  status: string;
  valid: boolean;
  invalidReasons: string[];
}

export interface ConditionCheck {
  loaded: boolean;
  problems: string[];
}

export interface RunRecord {
  schema: number;
  runId: string;
  task: string;
  category: string;
  condition: string;
  rep: number;
  warmth: 'cold' | 'warm';
  status: string;
  valid: boolean;
  invalidReasons: string[];
  usage: Usage & { totalTokens: number };
  totalCostUsd: number | null;
  numTurns: number;
  durationMs: number;
  firstTurnContextTokens: number | null;
  toolCalls: { total: number; mcp: number };
  checks: { solved: boolean; hiddenPass: boolean | null; visiblePass: boolean | null };
  [key: string]: unknown;
}

export interface ExecuteModule {
  classifyRun(input: {
    summary: StreamSummary;
    runInfo: { spawnError?: string; timedOut: boolean; durationMs: number };
    conditionCheck: ConditionCheck;
    prepareProblems: string[];
  }): Classification;
  buildRecord(input: Record<string, unknown>): RunRecord;
}

export interface Contribution {
  settings: Record<string, unknown>;
  mcpServers: Record<string, { type: string; command: string; args: string[]; env?: Record<string, string> }>;
  claudeMdLines: string[];
  allowedTools: string[];
  extraArgs: string[];
  env: Record<string, string>;
}

export interface FeatureInfo {
  available: boolean;
  reason?: string;
  version?: string;
}

export interface ConditionsModule {
  CONDITION_FEATURES: Record<string, string[]>;
  ALL_CONDITIONS: string[];
  contributionsFor(
    name: string,
    ctx: { workspace: string; maxifyHome: string },
    features: Record<string, FeatureInfo>,
  ): Contribution;
  verifyConditionLoaded(name: string, init: InitInfo | null): ConditionCheck;
  describeCondition(
    name: string,
    features: Record<string, FeatureInfo>,
  ): { name: string; available: boolean; reason: string };
}

export interface ClaudeModule {
  buildClaudeArgs(options: {
    prompt: string;
    model: string;
    maxTurns: number;
    mcpConfigPath: string;
    allowedTools: string[];
    maxBudgetUsd: number;
    effort?: string;
    extraArgs?: string[];
  }): string[];
  BUILTIN_TOOLS: string[];
  CLAUDE_ENV_OVERRIDES: Record<string, string>;
}

export interface AgentTask {
  id: string;
  dir: string;
  category: string;
  prompt: string;
  maxTurns: number;
  timeoutMs: number;
  allowedTools: string[];
  setupPatch: string | null;
  hiddenTest: string | null;
  hiddenTestName: string | null;
  solutionPatch: string | null;
  expect: { visibleFailsAfterSetup: boolean };
  answerChecks: Record<string, unknown> | null;
}

export interface TasksModule {
  loadAgentTasks(baseDir?: string, ids?: string[]): AgentTask[];
  validateTaskJson(raw: unknown, dirName: string, dir: string): string[];
  TASK_CATEGORIES: string[];
  DEFAULT_ALLOWED_TOOLS: string[];
}

export interface Cell {
  warmth: string;
  condition: string;
  runs: number;
  n: number;
  invalid: number;
  solved: number;
  successRate: number;
  meanTotalTokens: number;
  meanCostUsd: number;
  tokensPerSolved: number;
  lowSample: boolean;
  versusNative: { regression: boolean; fewerTokens: boolean; cheaper: boolean; worseSuccess: boolean } | null;
}

export interface Aggregate {
  cells: Cell[];
  taskRows: Array<Cell & { task: string }>;
  invalid: Array<{ task: string; condition: string; reasons: string[] }>;
  hasRegression: boolean;
  totalRuns: number;
}

export interface ResultsModule {
  RESULT_SCHEMA: number;
  aggregateRecords(records: RunRecord[]): Aggregate;
  renderAgentReport(aggregate: Aggregate, meta?: { sources?: string[] }): string;
  appendRecord(file: string, record: unknown): void;
  readRecords(files: string[]): RunRecord[];
  resultFiles(paths: string[]): string[];
}

export interface PlanModule {
  buildPlan(input: {
    tasks: Array<{ id: string }>;
    conditions: string[];
    reps: number;
    warmth: string;
    maxBudgetUsd: number;
    maxTotalUsd: number;
  }): { jobs: unknown[]; runs: number; runsPerJob: number; worstCaseUsd: number; perRunCapTotalUsd: number };
}

export interface ChecksModule {
  parseTapSummary(output: string): { tests: number | null; pass: number | null; fail: number | null; cancelled: number | null };
  evaluateAnswer(text: string, checks: Record<string, unknown>): { passed: boolean; failures: string[] };
}

export interface ArgsModule {
  parseArgs(
    argv: string[],
    schema: Record<string, { type: string; default?: unknown }>,
  ): { values: Record<string, unknown>; positionals: string[] };
  UsageError: new (message: string) => Error;
}

export interface WorkspaceModule {
  mergeSettings(base: Record<string, unknown>, extra: Record<string, unknown>): Record<string, unknown>;
  baseClaudeMd(nonce: string): string;
}

async function load<T>(relative: string): Promise<T> {
  const url = pathToFileURL(path.join(AGENT_DIR, relative)).href;
  return (await import(url)) as unknown as T;
}

export const loadStream = (): Promise<StreamModule> => load('lib/stream.mjs');
export const loadExecute = (): Promise<ExecuteModule> => load('lib/execute.mjs');
export const loadConditions = (): Promise<ConditionsModule> => load('lib/conditions.mjs');
export const loadClaude = (): Promise<ClaudeModule> => load('lib/claude.mjs');
export const loadTasks = (): Promise<TasksModule> => load('lib/tasks.mjs');
export const loadResults = (): Promise<ResultsModule> => load('lib/results.mjs');
export const loadPlan = (): Promise<PlanModule> => load('lib/plan.mjs');
export const loadChecks = (): Promise<ChecksModule> => load('lib/checks.mjs');
export const loadArgs = (): Promise<ArgsModule> => load('lib/args.mjs');
export const loadWorkspace = (): Promise<WorkspaceModule> => load('lib/workspace.mjs');

/** A synthetic stream-json transcript in the documented event shapes. NOT recorded from a real run. */
export function syntheticStream(options: {
  tools?: string[];
  mcpServers?: Array<{ name: string; status: string }>;
  plugins?: string[];
  subtype?: string;
  isError?: boolean;
  costUsd?: number;
  toolUses?: string[];
  resultText?: string;
  denials?: string[];
  withResult?: boolean;
} = {}): string {
  const events: Array<Record<string, unknown>> = [
    {
      type: 'system',
      subtype: 'init',
      session_id: 'synthetic-session',
      model: 'claude-synthetic',
      tools: options.tools ?? ['Read', 'Edit', 'Bash'],
      mcp_servers: options.mcpServers ?? [],
      plugins: options.plugins ?? [],
      slash_commands: ['compact'],
      apiKeySource: 'none',
      permissionMode: 'acceptEdits',
    },
  ];
  const toolUses = options.toolUses ?? ['Read', 'Edit'];
  toolUses.forEach((name, index) => {
    events.push({
      type: 'assistant',
      message: {
        id: `msg_${index}`,
        content: [{ type: 'tool_use', id: `tool_${index}`, name, input: {} }],
        usage: { input_tokens: 10 + index, output_tokens: 5, cache_creation_input_tokens: index === 0 ? 1000 : 0, cache_read_input_tokens: index === 0 ? 0 : 1000 },
      },
      parent_tool_use_id: null,
    });
    // The same message may be streamed again block by block: it must not be double counted.
    events.push({
      type: 'assistant',
      message: {
        id: `msg_${index}`,
        content: [{ type: 'text', text: 'working' }],
        usage: { input_tokens: 10 + index, output_tokens: 5, cache_creation_input_tokens: index === 0 ? 1000 : 0, cache_read_input_tokens: index === 0 ? 0 : 1000 },
      },
      parent_tool_use_id: null,
    });
    events.push({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: `tool_${index}`, content: 'x'.repeat(100), is_error: false }] },
    });
  });
  if (options.withResult !== false) {
    events.push({
      type: 'result',
      subtype: options.subtype ?? 'success',
      is_error: options.isError ?? false,
      duration_ms: 12_345,
      duration_api_ms: 10_000,
      num_turns: toolUses.length + 1,
      total_cost_usd: options.costUsd ?? 0.25,
      session_id: 'synthetic-session',
      result: options.resultText ?? 'done',
      usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 2000, cache_read_input_tokens: 4000 },
      permission_denials: (options.denials ?? []).map((name) => ({ tool_name: name })),
    });
  }
  return `${events.map((event) => JSON.stringify(event)).join('\n')}\n`;
}
