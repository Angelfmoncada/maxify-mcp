import { existsSync } from 'node:fs';
import { rejectPositionals } from '../args.js';
import { closeQuietly, engineOptions, locate, printResult, type CommandCall, type CommandSpec } from '../command.js';
import { resolveCliCommand } from '../cliCommand.js';
import {
  checkConfig,
  checkIndex,
  checkIndexUnavailable,
  checkMcpJson,
  checkNode,
  checkRoot,
  checkSqlite,
  checkStateDir,
  checkTypeScript,
  formatCheck,
  summarizeChecks,
  type CheckResult,
} from '../doctorChecks.js';
import type { RepoLocation } from '../root.js';

/** Environment the self-test server needs to find the same state as this process. */
const PASSTHROUGH_ENV = ['MAXIFY_HOME', 'XDG_CACHE_HOME', 'MAXIFY_DEBUG'] as const;

async function indexCheck(call: CommandCall, location: RepoLocation): Promise<CheckResult> {
  let engine;
  try {
    engine = await call.deps.openEngine(engineOptions(location, false));
  } catch (error: unknown) {
    return checkIndexUnavailable(error);
  }
  try {
    return await checkIndex(engine);
  } finally {
    // Closed before the self-test so the spawned server never contends with this handle.
    closeQuietly(engine);
  }
}

function selfTestArgs(call: CommandCall, location: RepoLocation): string[] {
  return [
    call.deps.cliPath,
    'serve',
    '--root',
    location.root,
    '--state-dir',
    location.stateDir,
    '--no-index',
    ...(location.configPath === undefined ? [] : ['--config', location.configPath]),
  ];
}

function passthroughEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const picked: Record<string, string> = {};
  for (const key of PASSTHROUGH_ENV) {
    const value = env[key];
    if (value !== undefined) picked[key] = value;
  }
  return picked;
}

async function selfTestCheck(call: CommandCall, location: RepoLocation): Promise<CheckResult> {
  const name = 'MCP self-test';
  if (!existsSync(call.deps.cliPath)) {
    return { status: 'WARN', name, detail: `skipped: ${call.deps.cliPath} not found (run "npm run build")` };
  }
  const result = await call.deps.runMcpSelfTest({
    command: process.execPath,
    args: selfTestArgs(call, location),
    env: passthroughEnv(call.deps.env),
    cwd: location.root,
  });
  return result.ok
    ? { status: 'PASS', name, detail: `${result.message} (${result.durationMs} ms)` }
    : { status: 'FAIL', name, detail: result.message };
}

async function surfaceCheck(call: CommandCall): Promise<CheckResult> {
  const name = 'Tool surface';
  try {
    const { describeToolSurface, formatSurface } = await import('../../mcp/surface.js');
    const surface = await describeToolSurface({
      version: call.deps.version,
      cliCommand: resolveCliCommand(call.deps.env, call.deps.cliPath),
    });
    return { status: 'PASS', name, detail: formatSurface(surface) };
  } catch (error: unknown) {
    return { status: 'FAIL', name, detail: error instanceof Error ? error.message : String(error) };
  }
}

async function collectChecks(call: CommandCall): Promise<CheckResult[]> {
  const checks: CheckResult[] = [checkNode(), await checkSqlite(), await checkTypeScript()];
  let location: RepoLocation | undefined;
  try {
    location = locate(call);
    checks.push(checkRoot(location));
  } catch (error: unknown) {
    checks.push({ status: 'FAIL', name: 'Repository root', detail: error instanceof Error ? error.message : String(error) });
  }
  if (location !== undefined) {
    checks.push(checkStateDir(location.stateDir), checkConfig(location), await indexCheck(call, location));
    checks.push(checkMcpJson(location.root), await selfTestCheck(call, location));
  }
  checks.push(await surfaceCheck(call));
  return checks;
}

export const doctorCommand: CommandSpec = {
  name: 'doctor',
  summary: 'Check the installation, the index and the MCP server end to end.',
  usage: 'doctor',
  details: ['Prints PASS, WARN or FAIL per check. Exits 1 if any check fails.'],
  options: {},
  optionDocs: [],
  async run(call) {
    rejectPositionals(call.positionals);
    const checks = await collectChecks(call);
    const summary = summarizeChecks(checks);
    const text = [
      ...checks.map(formatCheck),
      '',
      `${summary.passed} passed, ${summary.warnings} warning(s), ${summary.failed} failed`,
    ].join('\n');
    printResult(call, { text, meta: { checks, ...summary } });
    return summary.failed > 0 ? 1 : 0;
  },
};
