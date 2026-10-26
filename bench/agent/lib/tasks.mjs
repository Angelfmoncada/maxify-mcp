// Agent benchmark tasks: bench/tasks/agent/<id>/{task.json, setup.patch?, hidden.test.ts, solution.patch, ...}.
import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { AGENT_TASKS_DIR, readJson } from './util.mjs';

export const TASK_CATEGORIES = [
  'diagnosis',
  'multi-module',
  'contract-update',
  'failing-test',
  'post-edit',
  'tiny',
  'question',
];

/** Tools every task may use unless it narrows the list. MCP tools are added per condition. */
export const DEFAULT_ALLOWED_TOOLS = [
  'Read',
  'Edit',
  'Write',
  'Glob',
  'Grep',
  'Bash(node --test:*)',
  'Bash(npm test:*)',
  'Bash(npm run test:*)',
  'Bash(git diff:*)',
  'Bash(git status:*)',
  'Bash(ls:*)',
];

export const READ_ONLY_ALLOWED_TOOLS = ['Read', 'Glob', 'Grep', 'Bash(ls:*)'];

function isStringList(value) {
  return Array.isArray(value) && value.every((item) => typeof item === 'string' && item.length > 0);
}

/** Returns a list of problems with a parsed task.json (empty when sound). */
export function validateTaskJson(raw, dirName, dir) {
  const problems = [];
  const fail = (message) => problems.push(`${dirName}: ${message}`);
  if (raw === null || typeof raw !== 'object') return [`${dirName}: task.json must contain an object`];
  if (raw.id !== dirName) fail(`id "${raw.id}" must equal the directory name`);
  if (!TASK_CATEGORIES.includes(raw.category)) fail(`category must be one of ${TASK_CATEGORIES.join(', ')}`);
  if (typeof raw.title !== 'string' || raw.title.length === 0) fail('title is required');
  if (typeof raw.prompt !== 'string' || raw.prompt.length < 20) fail('prompt must be a string of at least 20 characters');
  if (!Number.isInteger(raw.maxTurns) || raw.maxTurns < 1 || raw.maxTurns > 100) fail('maxTurns must be an integer from 1 to 100');
  if (!Number.isInteger(raw.timeoutMs) || raw.timeoutMs < 60_000) fail('timeoutMs must be an integer of at least 60000');
  if (raw.allowedTools !== undefined && !isStringList(raw.allowedTools)) fail('allowedTools must be a list of strings');
  for (const key of ['setupPatch', 'hiddenTest', 'solutionPatch', 'referenceAnswer', 'wrongAnswer']) {
    if (raw[key] !== undefined && (typeof raw[key] !== 'string' || !existsSync(path.join(dir, raw[key])))) {
      fail(`${key} refers to a missing file: ${String(raw[key])}`);
    }
  }
  if (raw.category === 'question') {
    if (raw.answerChecks === undefined) fail('question tasks need answerChecks');
    if (raw.referenceAnswer === undefined || raw.wrongAnswer === undefined) fail('question tasks need referenceAnswer and wrongAnswer files');
  } else {
    if (raw.hiddenTest === undefined) fail('hiddenTest is required');
    if (raw.solutionPatch === undefined) fail('solutionPatch is required');
    if (raw.expect === null || typeof raw.expect !== 'object' || typeof raw.expect.visibleFailsAfterSetup !== 'boolean') {
      fail('expect.visibleFailsAfterSetup (boolean) is required');
    }
    if (raw.expect?.visibleFailsAfterSetup === true && raw.setupPatch === undefined) fail('visibleFailsAfterSetup needs a setupPatch');
  }
  return problems;
}

/** Loads one task directory. Throws with every problem found. */
export function loadAgentTask(dir) {
  const dirName = path.basename(dir);
  const raw = readJson(path.join(dir, 'task.json'));
  const problems = validateTaskJson(raw, dirName, dir);
  if (problems.length > 0) throw new Error(`Invalid agent task:\n- ${problems.join('\n- ')}`);
  const abs = (name) => (name === undefined ? null : path.join(dir, name));
  return {
    id: raw.id,
    dir,
    title: raw.title,
    category: raw.category,
    prompt: raw.prompt,
    maxTurns: raw.maxTurns,
    timeoutMs: raw.timeoutMs,
    allowedTools: raw.allowedTools ?? (raw.category === 'question' ? READ_ONLY_ALLOWED_TOOLS : DEFAULT_ALLOWED_TOOLS),
    setupPatch: abs(raw.setupPatch),
    hiddenTest: abs(raw.hiddenTest),
    hiddenTestName: raw.hiddenTest === undefined ? null : path.basename(raw.hiddenTest),
    solutionPatch: abs(raw.solutionPatch),
    expect: raw.expect ?? { visibleFailsAfterSetup: false },
    answerChecks: raw.answerChecks ?? null,
    referenceAnswer: abs(raw.referenceAnswer),
    wrongAnswer: abs(raw.wrongAnswer),
  };
}

/** Loads every task (sorted by id), or only the listed ids. Unknown ids are an error. */
export function loadAgentTasks(baseDir = AGENT_TASKS_DIR, ids = undefined) {
  if (!existsSync(baseDir)) throw new Error(`Agent task directory not found: ${baseDir}`);
  const available = readdirSync(baseDir)
    .filter((name) => statSync(path.join(baseDir, name)).isDirectory() && existsSync(path.join(baseDir, name, 'task.json')))
    .sort();
  const wanted = ids === undefined || ids.length === 0 ? available : ids;
  const unknown = wanted.filter((id) => !available.includes(id));
  if (unknown.length > 0) throw new Error(`Unknown agent task(s): ${unknown.join(', ')}. Available: ${available.join(', ')}`);
  return wanted.map((id) => loadAgentTask(path.join(baseDir, id)));
}
