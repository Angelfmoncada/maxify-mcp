import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { MAX_BUDGET, MIN_BUDGET } from '../../src/engine/types.js';
import { fixtureDir, readFixtureFiles, repoRoot, tasksDir } from '../../src/bench/fixture.js';
import {
  DEFAULT_BUDGETS,
  EXIT_INVALID,
  EXIT_NO_ENGINE,
  EXIT_OK,
  EXIT_REGRESSION,
  normalizeBudgets,
  runOfflineBench,
  runOfflineBenchWith,
  type OfflineBenchDeps,
} from '../../src/bench/offline.js';
import type { OfflineReport } from '../../src/bench/offline-types.js';
import { OFFLINE_NOTICE } from '../../src/bench/report.js';
import { loadSuite } from '../../src/bench/tasks.js';
import { createFakeEngineFactory, type FakeEngineBehavior } from './helpers/fake-engine.js';

const root = repoRoot();
const specs = loadSuite(tasksDir(root));
const baseline = readFixtureFiles(fixtureDir(root));
const scratch = mkdtempSync(path.join(os.tmpdir(), 'maxify-offline-test-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function deps(behavior: FakeEngineBehavior = {}): { deps: OfflineBenchDeps; log: ReturnType<typeof createFakeEngineFactory>['log'] } {
  const fake = createFakeEngineFactory(specs, behavior);
  return { deps: { openEngine: fake.openEngine, fixtureRoot: fixtureDir(root), tasksRoot: tasksDir(root), now: () => new Date('2026-01-02T03:04:05.000Z') }, log: fake.log };
}

async function runJson(behavior: FakeEngineBehavior = {}, budgets?: number[]) {
  const { deps: injected, log } = deps(behavior);
  const result = await runOfflineBenchWith(injected, { json: true, ...(budgets === undefined ? {} : { budgets }) });
  const report = JSON.parse(result.text) as OfflineReport & { aggregates: { hasAggregateRegression: boolean; costMore: unknown[]; taskRegressions: unknown[] } };
  return { result, report, log };
}

describe('normalizeBudgets', () => {
  it('defaults to 2000, 4000, 8000 and sorts and de-duplicates explicit lists', () => {
    expect(DEFAULT_BUDGETS).toEqual([2000, 4000, 8000]);
    expect(normalizeBudgets(undefined)).toEqual([2000, 4000, 8000]);
    expect(normalizeBudgets([])).toEqual([2000, 4000, 8000]);
    expect(normalizeBudgets([4000, 1000, 4000])).toEqual([1000, 4000]);
  });

  it('rejects budgets the engine would refuse', () => {
    expect(() => normalizeBudgets([MIN_BUDGET - 1])).toThrow(/between/);
    expect(() => normalizeBudgets([MAX_BUDGET + 1])).toThrow(/between/);
    expect(() => normalizeBudgets([1500.5])).toThrow(/integer/);
  });
});

describe('runOfflineBench with a perfect scripted engine', () => {
  it('reports every task at every budget with full recall and no regression', async () => {
    const { result, report, log } = await runJson();
    expect(result.exitCode).toBe(EXIT_OK);
    expect(report.notice).toBe(OFFLINE_NOTICE);
    expect(report.engine.available).toBe(true);
    expect(report.budgets).toEqual([2000, 4000, 8000]);
    expect(report.tasks).toHaveLength(specs.length);
    for (const task of report.tasks) {
      expect(task.maxify.map((run) => run.budget)).toEqual([2000, 4000, 8000]);
      for (const run of task.maxify) {
        expect(run.recallFirst, `${task.id}@${run.budget}`).toBe(1);
        expect(run.followUps).toEqual([]);
        expect(run.firstCall.overBudget).toBe(false);
        expect(run.totalCalls).toBe(1);
      }
      expect(task.simA.calls).toBeGreaterThanOrEqual(1);
      expect(task.simB.calls).toBeGreaterThanOrEqual(1);
    }
    expect(report.aggregates.hasAggregateRegression).toBe(false);
    expect(log.closed).toBe(true);
  });

  it('opens the engine on a temp copy with autoIndex off, indexes cold, then incrementally', async () => {
    const { report, log } = await runJson();
    expect(log.options).toHaveLength(1);
    const options = log.options[0];
    expect(options?.autoIndex).toBe(false);
    expect(options?.stateDir).toBeDefined();
    expect(options?.root).not.toBe(fixtureDir(root));
    expect(existsSync(options?.root ?? '')).toBe(false); // cleaned up
    expect(report.index?.coldFiles).toBeGreaterThan(40);
    expect(report.index?.incrementalChanged).toBe(1);
    expect(report.index?.incrementalUnchanged).toBeGreaterThan(40);
    expect(log.indexCalls).toBeGreaterThanOrEqual(3 + 2 * specs.filter((task) => task.edit !== undefined).length);
  });

  it('applies edits for post-edit tasks only while they run and never touches the original fixture', async () => {
    const { log } = await runJson({}, [2000]);
    const edited = specs.find((task) => task.id === 'pe-expiry-operator');
    const plain = specs.find((task) => task.id === 'diag-token-boundary');
    const editedCall = log.contextCalls.find((call) => call.task === edited?.prompt);
    const plainCall = log.contextCalls.find((call) => call.task === plain?.prompt);
    expect(editedCall?.seenFiles.get('src/server/auth/token.ts')).toContain('> payload.exp;');
    expect(editedCall?.seenFiles.get('src/server/auth/token.ts')).not.toContain('>= payload.exp');
    expect(plainCall?.seenFiles.get('src/server/auth/token.ts')).toContain('>= payload.exp');
    expect(readFixtureFiles(fixtureDir(root))).toEqual(baseline);
  });

  it('flags a re-index that does not notice the edit', async () => {
    const { report } = await runJson();
    for (const task of report.tasks.filter((entry) => specs.find((spec) => spec.id === entry.id)?.edit !== undefined)) {
      for (const run of task.maxify) expect(run.editDetected, task.id).toBe(true);
    }
  });
});

describe('diligent follow-up simulation', () => {
  it('calls source() once per missing requirement and counts its tokens', async () => {
    const dropped = 'src/server/auth/token.ts#verifyToken';
    const { report, log } = await runJson({ dropRefs: new Set([dropped]) }, [4000]);
    const task = report.tasks.find((entry) => entry.id === 'diag-token-boundary');
    const run = task?.maxify[0];
    expect(run?.recallFirst).toBeCloseTo(4 / 5);
    expect(run?.missedFirst).toEqual([dropped]);
    expect(run?.followUps).toHaveLength(1);
    expect(run?.followUps[0]).toMatchObject({ ref: dropped, tool: 'maxify_source', ok: true });
    expect(run?.recallFinal).toBe(1);
    expect(run?.totalCalls).toBe(2);
    expect(run?.totalTokens).toBe((run?.firstCall.tokens ?? 0) + (run?.followUpTokens ?? 0));
    expect(run?.followUpTokens).toBeGreaterThan(0);
    expect(log.sourceCalls.filter((ref) => ref === dropped).length).toBeGreaterThanOrEqual(1);
  });

  it('uses a cheap focused map-detail context call for gaps that only need a location', async () => {
    const dropped = 'test/token.test.ts';
    const { report, log } = await runJson({ dropRefs: new Set([dropped]) }, [4000]);
    const run = report.tasks.find((entry) => entry.id === 'diag-token-boundary')?.maxify[0];
    expect(run?.followUps).toHaveLength(1);
    expect(run?.followUps[0]).toMatchObject({ ref: dropped, tool: 'maxify_context', ok: true });
    expect(run?.recallFinal).toBe(1);
    expect(log.sourceCalls).not.toContain(dropped);
    expect(log.contextCalls.find((call) => call.task === `Locate ${dropped}`)?.budget).toBe(MIN_BUDGET);
  });

  it('keeps recall low when follow-ups fail, and reports the failure', async () => {
    const { report } = await runJson({ blind: true }, [4000]);
    for (const task of report.tasks) {
      const run = task.maxify[0];
      expect(run?.recallFirst).toBe(0);
      expect(run?.recallFinal).toBe(0);
      expect(run?.followUps.every((entry) => !entry.ok)).toBe(true);
      expect(run?.followUps).toHaveLength(task.requirementCount);
    }
  });
});

describe('regression flags', () => {
  it('flags fewer tokens with lower recall as a REGRESSION and exits with code 1', async () => {
    const { deps: injected } = deps({ blind: true });
    const result = await runOfflineBenchWith(injected, { budgets: [2000] });
    expect(result.exitCode).toBe(EXIT_REGRESSION);
    expect(result.text).toContain('REGRESSION');
    expect(result.text).toContain('fewer tokens, lower recall');
  });

  it('reports tasks where Maxify cost more than a baseline', async () => {
    const { report, result } = await runJson({ padWords: 30_000 }, [8000]);
    expect(report.aggregates.costMore.length).toBeGreaterThan(0);
    expect(result.exitCode).toBe(EXIT_REGRESSION); // over budget is a defect
    const text = (await runOfflineBenchWith(deps({ padWords: 30_000 }).deps, { budgets: [8000] })).text;
    expect(text).toContain('## Tasks where Maxify cost more than a baseline');
    expect(text).toContain('estimated size exceeds the budget');
  });

  it('counts decoys in the selected evidence as forbidden hits', async () => {
    const { report } = await runJson({ decoyPaths: ['src/legacy/auth/session-token.ts'] }, [2000]);
    const task = report.tasks.find((entry) => entry.id === 'diag-token-boundary');
    expect(task?.maxify[0]?.forbiddenHits).toEqual(['src/legacy/auth/session-token.ts']);
    expect(task?.maxify[0]?.forbiddenHitsStrong).toEqual([]); // the scripted decoy is shown at map level only
    const unrelated = report.tasks.find((entry) => entry.id === 'cu-labels');
    expect(unrelated?.maxify[0]?.forbiddenHits).toEqual([]);
  });

  it('checks required wording and stale text of freshness and uncertainty tasks', async () => {
    const stale = await runJson({ extraText: '>= payload.exp' }, [2000]);
    expect(stale.report.tasks.find((entry) => entry.id === 'pe-expiry-operator')?.maxify[0]?.forbiddenTextHits).toEqual(['>= payload.exp']);
    const quiet = await runJson({}, [2000]);
    expect(quiet.report.tasks.find((entry) => entry.id === 'unc-plugin-dynamic-import')?.maxify[0]?.requireTextOk).toBe(false);
    const noisy = await runJson({ extraText: 'unresolved dynamic import in loader.ts' }, [2000]);
    expect(noisy.report.tasks.find((entry) => entry.id === 'unc-plugin-dynamic-import')?.maxify[0]?.requireTextOk).toBe(true);
  });
});

describe('failure handling', () => {
  it('still reports the native baselines when the engine cannot be opened', async () => {
    const result = await runOfflineBenchWith(
      { openEngine: async () => Promise.reject(new Error('openEngine is not implemented yet')), fixtureRoot: fixtureDir(root), tasksRoot: tasksDir(root) },
      { json: true },
    );
    expect(result.exitCode).toBe(EXIT_NO_ENGINE);
    const report = JSON.parse(result.text) as OfflineReport;
    expect(report.engine.available).toBe(false);
    expect(report.engine.reason).toContain('not implemented');
    expect(report.tasks.every((task) => task.maxify.length === 0 && task.simA.tokens > 0 && task.simB.tokens > 0)).toBe(true);
  });

  it('shows n/a for Maxify columns in the Markdown report when the engine is unavailable', async () => {
    const result = await runOfflineBenchWith(
      { openEngine: async () => Promise.reject(new Error('boom')), fixtureRoot: fixtureDir(root), tasksRoot: tasksDir(root) },
      { budgets: [2000] },
    );
    expect(result.text).toContain('UNAVAILABLE (openEngine failed: boom)');
    expect(result.text).toContain('n/a');
  });

  it('records engine errors per task instead of aborting', async () => {
    const { report, result } = await runJson({ failContext: true }, [2000]);
    expect(result.exitCode).toBe(EXIT_REGRESSION);
    expect(report.tasks.every((task) => task.maxify[0]?.firstCall.error === 'context exploded')).toBe(true);
  });

  it('refuses invalid budgets, unknown suites and inconsistent ground truth with exit code 2', async () => {
    const { deps: injected } = deps();
    const badBudget = await runOfflineBenchWith(injected, { budgets: [10] });
    expect(badBudget.exitCode).toBe(EXIT_INVALID);
    expect(badBudget.text).toContain('cannot start');
    const badSuite = await runOfflineBenchWith(injected, { suite: 'no-such-suite' });
    expect(badSuite.exitCode).toBe(EXIT_INVALID);
    const brokenFixture = path.join(scratch, 'empty-fixture');
    const mismatched = await runOfflineBenchWith({ ...injected, fixtureRoot: path.join(root, 'bench', 'tasks') }, { budgets: [2000] });
    expect(mismatched.exitCode).toBe(EXIT_INVALID);
    expect(mismatched.text).toContain('does not match the fixture');
    expect(brokenFixture).toBeTruthy();
  });
});

describe('report output', () => {
  it('states the simulation notice on the first line of the report body and documents method and limits', async () => {
    const { deps: injected } = deps();
    const result = await runOfflineBenchWith(injected, { budgets: [2000] });
    const lines = result.text.split('\n');
    expect(lines[0]).toBe('# Maxify offline benchmark');
    expect(lines[2]).toBe(`> ${OFFLINE_NOTICE}`);
    for (const heading of ['## Summary by budget', '## Per-task results, budget 2000', '## Methodology and limitations', '## Checks and anomalies']) {
      expect(result.text).toContain(heading);
    }
    expect(result.text).toContain('optimistic for Maxify');
    for (const spec of specs) expect(result.text).toContain(spec.id);
  });

  it('writes the Markdown report and a JSON file next to it', async () => {
    const out = path.join(scratch, 'nested', 'report.md');
    const { deps: injected } = deps();
    const result = await runOfflineBenchWith(injected, { budgets: [2000], out });
    expect(readFileSync(out, 'utf8')).toBe(result.text);
    const json = JSON.parse(readFileSync(path.join(scratch, 'nested', 'report.json'), 'utf8')) as OfflineReport;
    expect(json.notice).toBe(OFFLINE_NOTICE);
    expect(json.tasks).toHaveLength(specs.length);
  });

  it('is deterministic apart from measured times', async () => {
    const strip = (report: OfflineReport): unknown =>
      JSON.parse(
        JSON.stringify(report, (key, value: unknown) =>
          ['latencyMs', 'coldMs', 'incrementalMs', 'latencyMedianMs', 'latencyMaxMs'].includes(key) ? 0 : value,
        ),
      );
    const first = await runJson({}, [2000, 4000]);
    const second = await runJson({}, [2000, 4000]);
    expect(strip(first.report)).toEqual(strip(second.report));
  });
});

describe('runOfflineBench (default wiring)', () => {
  it('exports the entry point with the documented signature and fails soft when the real engine is unusable', async () => {
    expect(typeof runOfflineBench).toBe('function');
    const result = await runOfflineBench({ budgets: [2000], suite: 'cu-labels' });
    expect([EXIT_OK, EXIT_REGRESSION, EXIT_NO_ENGINE]).toContain(result.exitCode);
    expect(result.text).toContain(OFFLINE_NOTICE);
  }, 120_000);
});
