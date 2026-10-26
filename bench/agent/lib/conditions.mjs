// Benchmark conditions = sets of features. Each feature knows how to detect itself (read-only checks),
// prepare a workspace, contribute configuration that is written ONLY inside the workspace, and
// verify from the stream-json init event that it really loaded.
import { existsSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { REPO_ROOT, readJson, run } from './util.mjs';

export const CONDITION_FEATURES = {
  native: [],
  caveman: ['caveman'],
  graphify: ['graphify-mcp'],
  'graphify-cli': ['graphify-cli'],
  'caveman+graphify': ['caveman', 'graphify-mcp'],
  'caveman+graphify-cli': ['caveman', 'graphify-cli'],
  maxify: ['maxify'],
};

export const ALL_CONDITIONS = Object.keys(CONDITION_FEATURES);

/** Conditions whose plugin hooks write small state files under the user's ~/.claude (opt-in, see README). */
export const CAVEMAN_CONDITIONS = ALL_CONDITIONS.filter((name) => CONDITION_FEATURES[name].includes('caveman'));

export const MAXIFY_CLI = path.join(REPO_ROOT, 'dist', 'cli.js');

const GRAPHIFY_MCP_LINES = [
  '## graphify',
  '',
  'A graphify knowledge graph of this project is available through the `graphify` MCP server',
  '(tools: query_graph, get_node, get_neighbors, get_community, god_nodes, graph_stats, shortest_path).',
  'For questions about the codebase, query the graph before grepping or reading source files, then read only the lines it points to.',
];

// ---------------------------------------------------------------- detection (read-only)

function detectCaveman() {
  const registry = path.join(os.homedir(), '.claude', 'plugins', 'installed_plugins.json');
  if (!existsSync(registry)) return { available: false, reason: `plugin registry not found: ${registry}` };
  let plugins;
  try {
    plugins = readJson(registry).plugins ?? {};
  } catch (error) {
    return { available: false, reason: `plugin registry unreadable: ${error.message}` };
  }
  const id = Object.keys(plugins).find((key) => /^caveman@/.test(key));
  const entry = id === undefined ? undefined : plugins[id]?.[0];
  if (id === undefined || entry === undefined) return { available: false, reason: 'no caveman plugin is installed (looked for caveman@* in installed_plugins.json)' };
  if (!existsSync(entry.installPath)) return { available: false, reason: `installPath missing: ${entry.installPath}` };
  return {
    available: true,
    pluginId: id,
    version: entry.version ?? 'unknown',
    gitCommitSha: entry.gitCommitSha ?? null,
    installPath: entry.installPath,
  };
}

function detectGraphify() {
  const version = run('graphify', ['--version'], { timeoutMs: 30_000 });
  if (!version.ok) {
    const hint = 'Install it yourself (the harness never installs anything): pipx install graphifyy';
    return { cli: { available: false, reason: `graphify not runnable: ${version.error ?? version.stderr.trim()}. ${hint}` }, mcp: { available: false, reason: `graphify not runnable. ${hint}` } };
  }
  const label = version.stdout.trim().split(/\r?\n/)[0] ?? 'graphify';
  const cli = { available: true, version: label };
  const probe = run('graphify-mcp', [path.join(os.tmpdir(), 'mxb-no-such-graph', 'graph.json')], { input: '', timeoutMs: 30_000 });
  const output = `${probe.stdout}\n${probe.stderr}`;
  if (/mcp not installed|No module named ['"]mcp['"]/i.test(output)) {
    return {
      cli,
      mcp: {
        available: false,
        version: label,
        reason: 'graphify-mcp cannot start: the Python package "mcp" is missing from the graphify environment (graphify installed without its [mcp] extra)',
        fix: 'your action, nothing was installed: pipx inject graphifyy mcp   (or: pipx install --force "graphifyy[mcp]")',
      },
    };
  }
  return { cli, mcp: { available: true, version: label } };
}

function detectMaxify() {
  if (!existsSync(MAXIFY_CLI)) return { available: false, reason: `${MAXIFY_CLI} not found. Build first (your action): npm run build` };
  const version = run(process.execPath, [MAXIFY_CLI, '--version'], { timeoutMs: 30_000 });
  return { available: true, cliPath: MAXIFY_CLI, version: version.ok ? version.stdout.trim().split(/\r?\n/)[0] : 'unknown' };
}

let detectionCache = null;

/** Detects every feature once per process. No installation, no writes. */
export function detectFeatures() {
  if (detectionCache !== null) return detectionCache;
  const graphify = detectGraphify();
  detectionCache = {
    caveman: detectCaveman(),
    'graphify-cli': graphify.cli,
    'graphify-mcp': graphify.mcp,
    maxify: detectMaxify(),
  };
  return detectionCache;
}

/** Availability of a condition given feature detection results. */
export function describeCondition(name, features = detectFeatures()) {
  const parts = CONDITION_FEATURES[name];
  if (parts === undefined) throw new Error(`Unknown condition "${name}". Known: ${ALL_CONDITIONS.join(', ')}`);
  const missing = parts.filter((id) => !features[id]?.available);
  const details = parts.map((id) => features[id]).filter((feature) => feature?.available);
  return {
    name,
    features: parts,
    available: missing.length === 0,
    reason: missing.map((id) => `${id}: ${features[id]?.reason ?? 'unavailable'}${features[id]?.fix ? ` Fix: ${features[id].fix}` : ''}`).join('; '),
    versions: details.map((feature) => feature.version).filter(Boolean),
    usesCaveman: parts.includes('caveman'),
  };
}

// ---------------------------------------------------------------- preparation

function graphifyEnv(fakeHome) {
  return {
    ...process.env,
    HOME: fakeHome,
    USERPROFILE: fakeHome,
    APPDATA: path.join(fakeHome, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(fakeHome, 'AppData', 'Local'),
  };
}

function prepareGraphify(ctx, installClaudeSection) {
  const started = Date.now();
  const build = run('graphify', ['update', '.'], { cwd: ctx.workspace, timeoutMs: 180_000, env: graphifyEnv(ctx.fakeHome) });
  const graph = path.join(ctx.workspace, 'graphify-out', 'graph.json');
  const counts = /Rebuilt:\s*(\d+) nodes,\s*(\d+) edges/.exec(build.stdout + build.stderr);
  const step = {
    feature: installClaudeSection ? 'graphify-cli' : 'graphify-mcp',
    ok: build.ok && existsSync(graph),
    ms: Date.now() - started,
    detail: counts === null ? 'graph built' : `graph: ${counts[1]} nodes, ${counts[2]} edges`,
  };
  if (!step.ok) return { ...step, detail: `graphify update failed: ${(build.stderr || build.stdout || build.error || '').slice(0, 300)}` };
  if (installClaudeSection) {
    const install = run('graphify', ['claude', 'install'], { cwd: ctx.workspace, timeoutMs: 60_000, env: graphifyEnv(ctx.fakeHome) });
    if (!install.ok) return { ...step, ok: false, detail: `graphify claude install failed: ${(install.stderr || install.stdout).slice(0, 300)}` };
  }
  return step;
}

function prepareMaxify(ctx) {
  if (ctx.warmth !== 'warm') return { feature: 'maxify', ok: true, ms: 0, detail: 'not pre-indexed (cold start)' };
  const started = Date.now();
  mkdirSync(ctx.maxifyHome, { recursive: true });
  const result = run(process.execPath, [MAXIFY_CLI, 'index', '--root', ctx.workspace], {
    timeoutMs: 180_000,
    env: { ...process.env, MAXIFY_HOME: ctx.maxifyHome, MAXIFY_QUIET: '1' },
  });
  return {
    feature: 'maxify',
    ok: result.ok,
    ms: Date.now() - started,
    detail: result.ok ? 'pre-indexed' : `maxify index failed: ${(result.stderr || result.stdout || result.error || '').slice(0, 300)}`,
  };
}

/** Runs the preparation steps of a condition's features inside the workspace. */
export function prepareCondition(name, ctx) {
  const steps = [];
  for (const id of CONDITION_FEATURES[name]) {
    if (id === 'graphify-cli') steps.push(prepareGraphify(ctx, true));
    else if (id === 'graphify-mcp') steps.push(prepareGraphify(ctx, false));
    else if (id === 'maxify') steps.push(prepareMaxify(ctx));
  }
  return steps;
}

// ---------------------------------------------------------------- contributions

/**
 * Configuration a condition adds on top of the shared base. Pure given its inputs.
 * ctx: { workspace, maxifyHome, cavemanLoad }; features: result of detectFeatures().
 */
export function contributionsFor(name, ctx, features) {
  const result = { settings: {}, mcpServers: {}, claudeMdLines: [], allowedTools: [], extraArgs: [], env: {} };
  for (const id of CONDITION_FEATURES[name]) {
    if (id === 'caveman') {
      const info = features.caveman;
      result.settings.enabledPlugins = { ...(result.settings.enabledPlugins ?? {}), [info.pluginId]: true };
      if (ctx.cavemanLoad === 'plugin-dir') result.extraArgs.push('--plugin-dir', info.installPath);
    } else if (id === 'graphify-cli') {
      result.allowedTools.push('Bash(graphify:*)');
    } else if (id === 'graphify-mcp') {
      result.mcpServers.graphify = { type: 'stdio', command: 'graphify-mcp', args: [path.join(ctx.workspace, 'graphify-out', 'graph.json')] };
      result.allowedTools.push('mcp__graphify');
      result.claudeMdLines.push(...GRAPHIFY_MCP_LINES);
    } else if (id === 'maxify') {
      result.mcpServers.maxify = {
        type: 'stdio',
        command: process.execPath,
        args: [MAXIFY_CLI, 'serve', '--root', ctx.workspace],
        env: { MAXIFY_HOME: ctx.maxifyHome, MAXIFY_QUIET: '1' },
      };
      result.allowedTools.push('mcp__maxify');
    }
  }
  return result;
}

// ---------------------------------------------------------------- verification of the init event

/**
 * Checks the stream-json init event for evidence that each feature loaded.
 * Returns { loaded, problems }. `init` may be null when the run died before initializing.
 */
export function verifyConditionLoaded(name, init) {
  const problems = [];
  const features = CONDITION_FEATURES[name];
  if (features.length === 0) return { loaded: true, problems };
  if (init === null) return { loaded: false, problems: ['no init event in the stream'] };
  for (const id of features) {
    if (id === 'caveman') {
      const seen =
        init.plugins.some((plugin) => /caveman/i.test(plugin)) ||
        init.slashCommands.some((command) => /^caveman[:\-]/i.test(command)) ||
        init.skills.some((skill) => /caveman/i.test(skill));
      if (!seen) problems.push('caveman plugin not visible in the init event (plugins, slash commands, skills)');
    } else if (id === 'graphify-mcp' || id === 'maxify') {
      const server = id === 'maxify' ? 'maxify' : 'graphify';
      const entry = init.mcpServers.find((candidate) => candidate.name === server);
      if (entry === undefined) problems.push(`MCP server "${server}" missing from init`);
      else if (entry.status !== 'connected') problems.push(`MCP server "${server}" status is ${entry.status}`);
      if (!init.tools.some((tool) => tool.startsWith(`mcp__${server}__`))) problems.push(`no mcp__${server}__* tools in init.tools`);
    }
  }
  return { loaded: problems.length === 0, problems };
}
