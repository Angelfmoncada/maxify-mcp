// Benchmark conditions = sets of features. Each feature knows how to detect itself (read-only checks),
// prepare a workspace, contribute configuration that is written ONLY inside the workspace, and
// verify from the stream-json init event that it really loaded.
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { REPO_ROOT, run } from './util.mjs';

export const CONDITION_FEATURES = {
  native: [],
  maxify: ['maxify'],
};

export const ALL_CONDITIONS = Object.keys(CONDITION_FEATURES);

export const MAXIFY_CLI = path.join(REPO_ROOT, 'dist', 'cli.js');

// ---------------------------------------------------------------- detection (read-only)

function detectMaxify() {
  if (!existsSync(MAXIFY_CLI)) return { available: false, reason: `${MAXIFY_CLI} not found. Build first (your action): npm run build` };
  const version = run(process.execPath, [MAXIFY_CLI, '--version'], { timeoutMs: 30_000 });
  return { available: true, cliPath: MAXIFY_CLI, version: version.ok ? version.stdout.trim().split(/\r?\n/)[0] : 'unknown' };
}

let detectionCache = null;

/** Detects every feature once per process. No installation, no writes. */
export function detectFeatures() {
  if (detectionCache !== null) return detectionCache;
  detectionCache = { maxify: detectMaxify() };
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
  };
}

// ---------------------------------------------------------------- preparation

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
    if (id === 'maxify') steps.push(prepareMaxify(ctx));
  }
  return steps;
}

// ---------------------------------------------------------------- contributions

/**
 * Configuration a condition adds on top of the shared base. Pure given its inputs.
 * ctx: { workspace, maxifyHome }; features: result of detectFeatures().
 */
export function contributionsFor(name, ctx, features) {
  const result = { settings: {}, mcpServers: {}, claudeMdLines: [], allowedTools: [], extraArgs: [], env: {} };
  for (const id of CONDITION_FEATURES[name]) {
    if (id === 'maxify') {
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
    if (id === 'maxify') {
      const server = 'maxify';
      const entry = init.mcpServers.find((candidate) => candidate.name === server);
      if (entry === undefined) problems.push(`MCP server "${server}" missing from init`);
      else if (entry.status !== 'connected') problems.push(`MCP server "${server}" status is ${entry.status}`);
      if (!init.tools.some((tool) => tool.startsWith(`mcp__${server}__`))) problems.push(`no mcp__${server}__* tools in init.tools`);
    }
  }
  return { loaded: problems.length === 0, problems };
}
