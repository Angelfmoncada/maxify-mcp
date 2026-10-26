/** Loading and validating offline task specs (bench/tasks/<suite>/*.json). */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { applyEditToFiles } from './fixture.js';
import { TASK_CATEGORIES, type OfflineTaskSpec } from './offline-types.js';
import { resolveRequirement } from './scoring.js';
import { LEVELS, parseRef } from './refs.js';

const requirementSchema = z
  .object({
    ref: z.string().min(1),
    level: z.enum(LEVELS),
    anchor: z.string().min(1).optional(),
  })
  .strict();

const taskSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'id must be lower-case words joined by dashes'),
    category: z.enum(TASK_CATEGORIES),
    prompt: z.string().min(10),
    required: z.array(requirementSchema).min(1),
    forbidden: z.array(z.string().min(1)),
    edit: z.object({ file: z.string().min(1), find: z.string().min(1), replace: z.string() }).strict().optional(),
    forbiddenText: z.array(z.string().min(1)).optional(),
    requireText: z.array(z.string().min(1)).optional(),
    notes: z.string().min(1),
  })
  .strict();

/** Parses one task document. Throws with the file name and every schema problem. */
export function parseTaskSpec(raw: unknown, source: string): OfflineTaskSpec {
  const parsed = taskSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`Invalid task spec ${source}: ${z.prettifyError(parsed.error)}`);
  const { edit, forbiddenText, requireText, ...rest } = parsed.data;
  return {
    ...rest,
    ...(edit === undefined ? {} : { edit }),
    ...(forbiddenText === undefined ? {} : { forbiddenText }),
    ...(requireText === undefined ? {} : { requireText }),
    required: rest.required.map((item) => ({
      ref: item.ref,
      level: item.level,
      ...(item.anchor === undefined ? {} : { anchor: item.anchor }),
    })),
  };
}

/** Loads every *.json file of `dir`, sorted by task id. Duplicate ids are rejected. */
export function loadTaskDir(dir: string): OfflineTaskSpec[] {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error(`Task directory not found: ${dir}`);
  const tasks: OfflineTaskSpec[] = [];
  for (const name of readdirSync(dir).filter((file) => file.endsWith('.json')).sort()) {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path.join(dir, name), 'utf8'));
    } catch (error: unknown) {
      throw new Error(`Invalid JSON in ${path.join(dir, name)}: ${error instanceof Error ? error.message : String(error)}`);
    }
    tasks.push(parseTaskSpec(raw, name));
  }
  const seen = new Set<string>();
  for (const task of tasks) {
    if (seen.has(task.id)) throw new Error(`Duplicate task id: ${task.id}`);
    seen.add(task.id);
  }
  return tasks.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Picks the tasks of a suite. `suite` is a directory name under bench/tasks ('offline');
 * otherwise it filters the offline tasks by category or by task id.
 */
export function loadSuite(tasksRoot: string, suite?: string): OfflineTaskSpec[] {
  const name = suite === undefined || suite === '' ? 'offline' : suite;
  const suiteDir = path.join(tasksRoot, name);
  if (existsSync(suiteDir) && statSync(suiteDir).isDirectory()) return loadTaskDir(suiteDir);
  const matching = loadTaskDir(path.join(tasksRoot, 'offline')).filter(
    (task) => task.category === name || task.id === name,
  );
  if (matching.length === 0) throw new Error(`Unknown suite "${name}": not a directory under ${tasksRoot}, a task category or a task id`);
  return matching;
}

/**
 * Checks that a task's ground truth holds against the fixture: files exist, symbols resolve,
 * range anchors match, the edit applies once, and regular expressions compile.
 * Returns human-readable problems (empty when the task is sound).
 */
export function validateTaskAgainstFixture(task: OfflineTaskSpec, baseFiles: ReadonlyMap<string, string>): string[] {
  const problems: string[] = [];
  let files = baseFiles;
  if (task.edit !== undefined) {
    try {
      files = applyEditToFiles(baseFiles, task.edit);
    } catch (error: unknown) {
      return [`${task.id}: ${error instanceof Error ? error.message : String(error)}`];
    }
  }
  for (const spec of task.required) {
    const resolved = resolveRequirement(spec, files);
    if (resolved.span === null) {
      problems.push(`${task.id}: required ref "${spec.ref}" does not resolve (${resolved.problem ?? 'unknown'})`);
      continue;
    }
    if (spec.anchor !== undefined) {
      const lines = (files.get(resolved.parsed.path) ?? '').split(/\r?\n/);
      const region = lines.slice(resolved.span.startLine - 1, resolved.span.endLine).join('\n');
      if (!region.includes(spec.anchor)) problems.push(`${task.id}: anchor ${JSON.stringify(spec.anchor)} not found inside "${spec.ref}"`);
    }
  }
  for (const ref of task.forbidden) {
    try {
      const target = parseRef(ref).path;
      const exists = target.endsWith('/') ? [...files.keys()].some((file) => file.startsWith(target)) : files.has(target);
      if (!exists) problems.push(`${task.id}: forbidden ref "${ref}" points at a path that does not exist`);
    } catch (error: unknown) {
      problems.push(`${task.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  for (const pattern of task.requireText ?? []) {
    try {
      new RegExp(pattern, 'i');
    } catch {
      problems.push(`${task.id}: requireText pattern does not compile: ${pattern}`);
    }
  }
  return problems;
}
