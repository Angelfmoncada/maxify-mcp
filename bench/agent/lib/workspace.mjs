// Per-run workspace: a fresh copy of the fixture in its own git repository.
// Everything configurable lives INSIDE the copy; nothing under the user's home is read for writing here.
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { FIXTURE_DIR, git, readJson, writeJson } from './util.mjs';

const SKIPPED = new Set(['node_modules', '.git', 'dist', 'coverage']);

/** Project memory shared by every condition so that only the condition's own lines differ. */
export function baseClaudeMd(nonce) {
  return [
    '# Taskboard',
    '',
    'Small task board (Node API plus React client) written in TypeScript.',
    '',
    '- Run the whole test suite with `npm test` (it uses `node --test`, no build step).',
    '- Server and shared code run through Node type stripping: no enums, namespaces or constructor parameter properties, and relative imports end in `.ts`.',
    '- Keep changes minimal and in the existing style. Do not edit existing tests unless the task needs it.',
    '- When you are done, reply with a short summary of what you changed or found.',
    '',
    `<!-- run ${nonce} -->`,
    '',
  ].join('\n');
}

/** Applies a patch with git, retrying once while ignoring whitespace (line-ending drift). */
export function applyPatch(dir, patchFile) {
  let result = git(dir, ['apply', '--whitespace=nowarn', patchFile]);
  if (!result.ok) result = git(dir, ['apply', '--whitespace=nowarn', '--ignore-whitespace', patchFile]);
  if (!result.ok) throw new Error(`git apply failed for ${patchFile}: ${result.stderr || result.error}`);
}

export function commitAll(dir, message) {
  git(dir, ['add', '-A']);
  const result = git(dir, ['commit', '-q', '--allow-empty', '-m', message]);
  if (!result.ok) throw new Error(`git commit failed: ${result.stderr || result.error}`);
}

/**
 * Copies the fixture to <tempRoot>/ws, commits it as a baseline and applies the task's setup patch
 * (committed separately, so later diffs only show what the agent did).
 */
export function createWorkspace({ tempRoot, setupPatch }) {
  const dir = path.join(tempRoot, 'ws');
  cpSync(FIXTURE_DIR, dir, { recursive: true, filter: (entry) => !SKIPPED.has(path.basename(entry)) });
  const init = git(dir, ['init', '-q']);
  if (!init.ok) throw new Error(`git init failed: ${init.stderr || init.error}`);
  commitAll(dir, 'baseline');
  if (setupPatch !== undefined && setupPatch !== null) {
    applyPatch(dir, setupPatch);
    commitAll(dir, 'task setup');
  }
  return dir;
}

/** Restores tracked files and removes new untracked ones; git-excluded condition files survive. */
export function resetWorkspace(dir) {
  const reset = git(dir, ['reset', '--hard', 'HEAD']);
  const clean = git(dir, ['clean', '-fdq']);
  if (!reset.ok || !clean.ok) throw new Error(`could not reset workspace: ${reset.stderr || clean.stderr}`);
}

/** Hides condition files from git status and diffs without touching any tracked file. */
export function excludeFromGit(dir, patterns) {
  const file = path.join(dir, '.git', 'info', 'exclude');
  mkdirSync(path.dirname(file), { recursive: true });
  const existing = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const missing = patterns.filter((pattern) => !existing.split(/\r?\n/).includes(pattern));
  if (missing.length > 0) appendFileSync(file, `${existing.endsWith('\n') || existing === '' ? '' : '\n'}${missing.join('\n')}\n`);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Deep merge for settings files: objects merge, arrays concatenate without duplicates, scalars are replaced. */
export function mergeSettings(base, extra) {
  const result = { ...base };
  for (const [key, value] of Object.entries(extra)) {
    const current = result[key];
    if (isPlainObject(current) && isPlainObject(value)) result[key] = mergeSettings(current, value);
    else if (Array.isArray(current) && Array.isArray(value)) {
      result[key] = [...current, ...value.filter((item) => !current.some((existing) => JSON.stringify(existing) === JSON.stringify(item)))];
    } else result[key] = value;
  }
  return result;
}

/** Deletes every file a previous run's condition setup may have left (they are git-excluded, so reset keeps them). */
export function removeConditionFiles(dir) {
  for (const entry of ['CLAUDE.md', '.claude', '.mcp.json']) {
    rmSync(path.join(dir, entry), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

/** Step 1 of condition setup: the project memory every condition shares. */
export function writeBaseClaudeMd(dir, nonce) {
  writeFileSync(path.join(dir, 'CLAUDE.md'), baseClaudeMd(nonce));
  excludeFromGit(dir, ['CLAUDE.md', '.claude/', '.mcp.json']);
}

/**
 * Last step of condition setup. Appends the condition's CLAUDE.md lines, merges its settings into
 * .claude/settings.json (a preparation step may already have written settings there)
 * and writes .mcp.json. Returns the absolute path of .mcp.json.
 */
export function writeConditionFiles(dir, { claudeMdLines, settings, mcpServers }) {
  if (claudeMdLines.length > 0) {
    appendFileSync(path.join(dir, 'CLAUDE.md'), `\n${claudeMdLines.join('\n')}\n`);
  }
  const settingsFile = path.join(dir, '.claude', 'settings.json');
  const current = existsSync(settingsFile) ? readJson(settingsFile) : {};
  writeJson(settingsFile, mergeSettings(current, settings));
  const mcpFile = path.join(dir, '.mcp.json');
  writeJson(mcpFile, { mcpServers });
  return mcpFile;
}

/** Removes a directory tree, tolerating read-only git objects and brief Windows file locks. */
export function removeTree(dir) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
  } catch {
    // A leftover temp directory is harmless; the OS temp cleaner will collect it.
  }
}
