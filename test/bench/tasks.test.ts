import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { applyEditToFiles, fixtureDir, readFixtureFiles, repoRoot, replaceOnce, tasksDir } from '../../src/bench/fixture.js';
import { TASK_CATEGORIES, type OfflineTaskSpec } from '../../src/bench/offline-types.js';
import { formatRef, parseRef } from '../../src/bench/refs.js';
import { scoreRecall, forbiddenHits, resolveRequirement, type Evidence } from '../../src/bench/scoring.js';
import { loadSuite, loadTaskDir, parseTaskSpec, validateTaskAgainstFixture } from '../../src/bench/tasks.js';

const root = repoRoot();
const baseFiles = readFixtureFiles(fixtureDir(root));
const tasks = loadSuite(tasksDir(root));

describe('offline task suite', () => {
  it('has at least 12 tasks with unique ids covering every category', () => {
    expect(tasks.length).toBeGreaterThanOrEqual(12);
    expect(new Set(tasks.map((task) => task.id)).size).toBe(tasks.length);
    const categories = new Set(tasks.map((task) => task.category));
    for (const category of TASK_CATEGORIES) expect(categories.has(category), `category ${category}`).toBe(true);
  });

  it('keeps ground truth consistent with the fixture: files exist, symbols resolve, anchors match, edits apply', () => {
    const problems = tasks.flatMap((task) => validateTaskAgainstFixture(task, baseFiles));
    expect(problems).toEqual([]);
  });

  it('never requires something it also forbids', () => {
    for (const task of tasks) {
      for (const requirement of task.required) {
        const required = parseRef(requirement.ref);
        const clash = task.forbidden.some((ref) => {
          const forbidden = parseRef(ref);
          if (forbidden.kind === 'file') return forbidden.path.endsWith('/') ? required.path.startsWith(forbidden.path) : forbidden.path === required.path;
          return formatRef(forbidden) === formatRef(required);
        });
        expect(clash, `${task.id}: ${requirement.ref}`).toBe(false);
      }
    }
  });

  it('can be satisfied: exact source evidence for every requirement gives full recall and no decoy hits', () => {
    for (const task of tasks) {
      const files = task.edit === undefined ? baseFiles : applyEditToFiles(baseFiles, task.edit);
      const resolved = task.required.map((spec) => resolveRequirement(spec, files));
      const evidence: Evidence[] = resolved.map((requirement) => ({
        path: requirement.parsed.path,
        startLine: requirement.span?.startLine ?? 1,
        endLine: requirement.span?.endLine ?? 1,
        level: 'source',
      }));
      expect(scoreRecall(resolved, evidence).recall, task.id).toBe(1);
      expect(forbiddenHits(task.forbidden, evidence), task.id).toEqual([]);
    }
  });

  it('gives each task a meaningful shape for its category', () => {
    for (const task of tasks) {
      expect(task.required.length, task.id).toBeGreaterThanOrEqual(1);
      expect(task.prompt.length, task.id).toBeGreaterThan(30);
      if (task.category === 'post-edit') expect(task.edit, task.id).toBeDefined();
      if (task.category === 'decoy') expect(task.forbidden.length, task.id).toBeGreaterThanOrEqual(2);
      if (task.category === 'uncertainty') expect(task.requireText?.length ?? 0, task.id).toBeGreaterThan(0);
      if (task.category === 'small') expect(task.required.length, task.id).toBeLessThanOrEqual(2);
      if (task.edit === undefined) expect(task.forbiddenText, task.id).toBeUndefined();
    }
  });

  it('makes post-edit freshness checks meaningful: stale text exists before the edit and not after', () => {
    for (const task of tasks.filter((entry) => entry.edit !== undefined && entry.forbiddenText !== undefined)) {
      const before = baseFiles.get(task.edit?.file ?? '') ?? '';
      const after = applyEditToFiles(baseFiles, task.edit as NonNullable<OfflineTaskSpec['edit']>).get(task.edit?.file ?? '') ?? '';
      for (const stale of task.forbiddenText ?? []) {
        expect(before.includes(stale), `${task.id} stale text present before`).toBe(true);
        expect(after.includes(stale), `${task.id} stale text gone after`).toBe(false);
      }
    }
  });

  it('exercises line-range refs with an anchor', () => {
    expect(tasks.some((task) => task.required.some((requirement) => /:\d+-\d+$/.test(requirement.ref) && requirement.anchor !== undefined))).toBe(true);
  });

  it('exercises test symbols, CommonJS symbols and variable symbols', () => {
    const refs = tasks.flatMap((task) => task.required.map((requirement) => requirement.ref));
    expect(refs.some((ref) => ref.includes('.test.ts#') && ref.includes(' > '))).toBe(true);
    expect(refs.some((ref) => ref.includes('.cjs#'))).toBe(true);
    expect(refs.some((ref) => ref.includes('#TASK_PRIORITIES') || ref.includes('#DEFAULT_PAGE_SIZE'))).toBe(true);
  });
});

describe('suite selection', () => {
  it('selects by directory, category or task id and rejects unknown names', () => {
    expect(loadSuite(tasksDir(root), 'offline')).toHaveLength(tasks.length);
    expect(loadSuite(tasksDir(root)).map((task) => task.id)).toEqual(tasks.map((task) => task.id));
    expect(loadSuite(tasksDir(root), 'decoy').every((task) => task.category === 'decoy')).toBe(true);
    expect(loadSuite(tasksDir(root), 'cu-labels')).toHaveLength(1);
    expect(() => loadSuite(tasksDir(root), 'no-such-suite')).toThrow(/Unknown suite/);
  });
});

describe('parseTaskSpec', () => {
  const valid = {
    id: 'sample-task',
    category: 'small',
    prompt: 'Change the default page size for task listings.',
    required: [{ ref: 'src/shared/constants.ts#DEFAULT_PAGE_SIZE', level: 'source' }],
    forbidden: [],
    notes: 'sample',
  };

  it('accepts a valid spec', () => {
    expect(parseTaskSpec(valid, 'x.json').id).toBe('sample-task');
  });

  it('rejects unknown fields, bad levels, bad ids and empty requirement lists', () => {
    expect(() => parseTaskSpec({ ...valid, extra: 1 }, 'x.json')).toThrow(/Invalid task spec x\.json/);
    expect(() => parseTaskSpec({ ...valid, required: [{ ref: 'a.ts', level: 'full' }] }, 'x.json')).toThrow();
    expect(() => parseTaskSpec({ ...valid, id: 'Bad Id' }, 'x.json')).toThrow();
    expect(() => parseTaskSpec({ ...valid, required: [] }, 'x.json')).toThrow();
    expect(() => parseTaskSpec({ ...valid, category: 'other' }, 'x.json')).toThrow();
  });
});

describe('validateTaskAgainstFixture', () => {
  const base: OfflineTaskSpec = {
    id: 'probe',
    category: 'small',
    prompt: 'A prompt that is long enough to be valid here.',
    required: [{ ref: 'src/shared/constants.ts#DEFAULT_PAGE_SIZE', level: 'source' }],
    forbidden: [],
    notes: 'n',
  };

  it('reports missing files, missing symbols, bad anchors and out-of-range lines', () => {
    expect(validateTaskAgainstFixture(base, baseFiles)).toEqual([]);
    expect(validateTaskAgainstFixture({ ...base, required: [{ ref: 'src/nope.ts', level: 'map' }] }, baseFiles)[0]).toMatch(/does not exist/);
    expect(validateTaskAgainstFixture({ ...base, required: [{ ref: 'src/shared/constants.ts#NOPE', level: 'map' }] }, baseFiles)[0]).toMatch(/not found/);
    expect(
      validateTaskAgainstFixture({ ...base, required: [{ ref: 'src/shared/constants.ts:1-2', level: 'source', anchor: 'MISSING TEXT' }] }, baseFiles)[0],
    ).toMatch(/anchor/);
    expect(validateTaskAgainstFixture({ ...base, required: [{ ref: 'src/shared/constants.ts:1-9999', level: 'map' }] }, baseFiles)[0]).toMatch(/past line/);
  });

  it('reports forbidden refs that point nowhere and bad regular expressions', () => {
    expect(validateTaskAgainstFixture({ ...base, forbidden: ['src/ghost.ts'] }, baseFiles)[0]).toMatch(/does not exist/);
    expect(validateTaskAgainstFixture({ ...base, requireText: ['('] }, baseFiles)[0]).toMatch(/does not compile/);
  });

  it('reports edits that do not apply exactly once', () => {
    const missing = { ...base, edit: { file: 'src/shared/constants.ts', find: 'NOT PRESENT', replace: 'x' } };
    expect(validateTaskAgainstFixture(missing, baseFiles)[0]).toMatch(/not found/);
    const ambiguous = { ...base, edit: { file: 'src/shared/constants.ts', find: 'export const', replace: 'x' } };
    expect(validateTaskAgainstFixture(ambiguous, baseFiles)[0]).toMatch(/ambiguous/);
    const noFile = { ...base, edit: { file: 'src/none.ts', find: 'a', replace: 'b' } };
    expect(validateTaskAgainstFixture(noFile, baseFiles)[0]).toMatch(/not found in fixture/);
  });

  it('applies an edit before resolving refs', () => {
    const task: OfflineTaskSpec = {
      ...base,
      required: [{ ref: 'src/shared/constants.ts#BRAND_NEW', level: 'source' }],
      edit: { file: 'src/shared/constants.ts', find: 'export const MAX_PAGE_SIZE = 100;', replace: 'export const MAX_PAGE_SIZE = 100;\nexport const BRAND_NEW = 1;' },
    };
    expect(validateTaskAgainstFixture(task, baseFiles)).toEqual([]);
  });
});

describe('replaceOnce', () => {
  it('replaces a unique occurrence and refuses others', () => {
    expect(replaceOnce('a b c', { file: 'f', find: 'b', replace: 'X' })).toBe('a X c');
    expect(() => replaceOnce('a b b', { file: 'f', find: 'b', replace: 'X' })).toThrow(/ambiguous/);
    expect(() => replaceOnce('a', { file: 'f', find: 'z', replace: 'X' })).toThrow(/not found/);
  });
});

describe('loadTaskDir', () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'maxify-tasks-test-'));
  afterAll(() => rmSync(temp, { recursive: true, force: true }));

  const spec = (id: string) =>
    JSON.stringify({ id, category: 'small', prompt: 'A prompt that is long enough to pass.', required: [{ ref: 'a.ts', level: 'map' }], forbidden: [], notes: 'n' });

  it('rejects duplicate ids, broken JSON and missing directories', () => {
    const dir = path.join(temp, 'dups');
    mkdirSync(dir);
    writeFileSync(path.join(dir, 'a.json'), spec('same'));
    writeFileSync(path.join(dir, 'b.json'), spec('same'));
    expect(() => loadTaskDir(dir)).toThrow(/Duplicate task id/);
    const broken = path.join(temp, 'broken');
    mkdirSync(broken);
    writeFileSync(path.join(broken, 'a.json'), '{ nope');
    expect(() => loadTaskDir(broken)).toThrow(/Invalid JSON/);
    expect(() => loadTaskDir(path.join(temp, 'missing'))).toThrow(/not found/);
  });

  it('sorts tasks by id', () => {
    const dir = path.join(temp, 'sorted');
    mkdirSync(dir);
    writeFileSync(path.join(dir, '1.json'), spec('zeta'));
    writeFileSync(path.join(dir, '2.json'), spec('alpha'));
    expect(loadTaskDir(dir).map((task) => task.id)).toEqual(['alpha', 'zeta']);
  });
});
