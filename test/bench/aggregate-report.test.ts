import { describe, expect, it } from 'vitest';
import { aggregate, mean, median, sum } from '../../src/bench/aggregate.js';
import type { MaxifyTaskRun, OfflineReport, SimRun, TaskResult } from '../../src/bench/offline-types.js';
import { OFFLINE_NOTICE, renderJson, renderMarkdown } from '../../src/bench/report.js';

function sim(tokens: number, recall: number, strategy: SimRun['strategy'] = 'grep-read-files'): SimRun {
  return { strategy, keywords: ['alpha'], calls: 4, tokens, perCall: [], reads: [], recall, missed: [], forbiddenRead: [] };
}

function run(budget: number, first: number, total: number, recallFirst: number, recallFinal: number, extra: Partial<MaxifyTaskRun> = {}): MaxifyTaskRun {
  return {
    budget,
    firstCall: { label: 'maxify_context', argTokens: 10, resultTokens: first - 22, tokens: first, engineEstTokens: first - 22, latencyMs: 12, complete: true, overBudget: false, itemCount: 3, omittedCount: 0 },
    recallFirst,
    missedFirst: [],
    followUps: [],
    followUpTokens: total - first,
    totalTokens: total,
    totalCalls: total > first ? 2 : 1,
    recallFinal,
    missedFinal: [],
    forbiddenHits: [],
    forbiddenHitsStrong: [],
    forbiddenMentions: [],
    forbiddenTextHits: [],
    ...extra,
  };
}

function task(id: string, a: SimRun, b: SimRun, runs: MaxifyTaskRun[]): TaskResult {
  return { id, category: 'diagnosis', prompt: `prompt of ${id}`, requirementCount: 4, requirements: [{ ref: 'a.ts', level: 'source' }], simA: a, simB: b, maxify: runs };
}

function report(tasks: TaskResult[], budgets: number[] = [2000], engineAvailable = true): OfflineReport {
  return {
    generatedAt: '2026-01-01T00:00:00.000Z',
    notice: OFFLINE_NOTICE,
    fixture: { name: 'taskboard', files: 60, lines: 3700 },
    budgets,
    engine: engineAvailable ? { available: true } : { available: false, reason: 'not built' },
    index: engineAvailable ? { coldMs: 300, coldFiles: 60, coldErrors: 0, incrementalMs: 20, incrementalChanged: 1, incrementalUnchanged: 59 } : null,
    tasks,
    constants: { perCallOverheadTokens: 12, maxKeywords: 10, readFileCount: 3, windowRadius: 25, maxWindows: 8 },
  };
}

describe('statistics helpers', () => {
  it('computes mean, sum and median with empty-list safety', () => {
    expect(mean([1, 2, 3, 4])).toBe(2.5);
    expect(mean([])).toBe(0);
    expect(sum([1, 2, 3])).toBe(6);
    expect(median([5, 1, 3])).toBe(3);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([])).toBe(0);
  });
});

describe('aggregate', () => {
  const good = report([
    task('t1', sim(6000, 0.5), sim(12000, 0.75, 'grep-read-ranges'), [run(2000, 2000, 2400, 0.5, 1)]),
    task('t2', sim(4000, 0.25), sim(10000, 0.5, 'grep-read-ranges'), [run(2000, 1800, 1800, 0.75, 0.75)]),
  ]);

  it('averages tokens and recall per budget and compares scopes against both baselines', () => {
    const summary = aggregate(good).budgets[0];
    expect(summary?.maxify?.meanFirstTokens).toBe(1900);
    expect(summary?.maxify?.meanTotalTokens).toBe(2100);
    expect(summary?.maxify?.meanRecallFirst).toBe(0.625);
    expect(summary?.maxify?.meanRecallFinal).toBe(0.875);
    expect(summary?.simA.meanTokens).toBe(5000);
    expect(summary?.comparisons).toHaveLength(4);
    expect(summary?.comparisons.every((entry) => !entry.regression)).toBe(true);
    expect(aggregate(good).hasAggregateRegression).toBe(false);
  });

  it('flags fewer tokens with lower recall, per task and in aggregate', () => {
    const bad = report([
      task('cheap-but-blind', sim(6000, 0.8), sim(12000, 0.9, 'grep-read-ranges'), [run(2000, 1000, 1000, 0.2, 0.2)]),
    ]);
    const result = aggregate(bad);
    expect(result.hasAggregateRegression).toBe(true);
    expect(result.taskRegressions.map((entry) => `${entry.baseline}:${entry.scope}`).sort()).toEqual([
      'A:first-call',
      'A:with-follow-ups',
      'B:first-call',
      'B:with-follow-ups',
    ]);
    expect(result.budgets[0]?.comparisons.find((entry) => entry.baseline === 'A' && entry.scope === 'first-call')?.tokenChange).toBeCloseTo(-5 / 6);
  });

  it('does not call a regression when recall is equal or better, or tokens are not lower', () => {
    const tie = aggregate(report([task('tie', sim(6000, 0.5), sim(12000, 0.5, 'grep-read-ranges'), [run(2000, 1000, 1000, 0.5, 0.5)])]));
    expect(tie.hasAggregateRegression).toBe(false);
    const pricey = aggregate(report([task('pricey', sim(900, 0.9), sim(900, 0.9, 'grep-read-ranges'), [run(2000, 1000, 1000, 0.2, 0.2)])]));
    expect(pricey.hasAggregateRegression).toBe(false);
  });

  it('lists tasks where Maxify cost more than a baseline, naming the scope', () => {
    const result = aggregate(
      report([
        task('big', sim(1500, 1), sim(20000, 1, 'grep-read-ranges'), [run(2000, 1400, 1900, 1, 1)]),
        task('small', sim(5000, 1), sim(9000, 1, 'grep-read-ranges'), [run(2000, 1000, 1100, 1, 1)]),
      ]),
    );
    expect(result.costMore).toHaveLength(1);
    expect(result.costMore[0]).toMatchObject({ taskId: 'big', budget: 2000, worseThan: ['with-follow-ups vs A'] });
    const equal = aggregate(report([task('same', sim(1000, 1), sim(9000, 1, 'grep-read-ranges'), [run(2000, 1000, 1000, 1, 1)])]));
    expect(equal.costMore).toEqual([]);
  });

  it('counts decoys by level and quality flags', () => {
    const flagged = aggregate(
      report([
        task('decoy', sim(6000, 1), sim(9000, 1, 'grep-read-ranges'), [
          run(2000, 1000, 1000, 1, 1, { forbiddenHits: ['x'], forbiddenHitsStrong: ['x'], forbiddenMentions: ['y'] }),
        ]),
        task('mapped', sim(6000, 1), sim(9000, 1, 'grep-read-ranges'), [run(2000, 1000, 1000, 1, 1, { forbiddenHits: ['x'] })]),
        task('clean', sim(6000, 1), sim(9000, 1, 'grep-read-ranges'), [run(2000, 1000, 1000, 1, 1, { firstCall: { ...run(2000, 1000, 1000, 1, 1).firstCall, overBudget: true, complete: false } })]),
      ]),
    );
    const summary = flagged.budgets[0]?.maxify;
    expect(summary?.tasksWithForbiddenHits).toBe(2);
    expect(summary?.tasksWithStrongForbiddenHits).toBe(1);
    expect(summary?.tasksMentioningForbidden).toBe(1);
    expect(summary?.overBudget).toBe(1);
    expect(summary?.incomplete).toBe(1);
  });

  it('reports baselines only when there are no Maxify runs', () => {
    const result = aggregate(report([task('t', sim(100, 1), sim(200, 1, 'grep-read-ranges'), [])], [2000], false));
    expect(result.budgets[0]?.maxify).toBeNull();
    expect(result.budgets[0]?.comparisons).toEqual([]);
    expect(result.costMore).toEqual([]);
    expect(result.hasAggregateRegression).toBe(false);
  });
});

describe('renderMarkdown and renderJson', () => {
  const tasks = [task('t1', sim(6000, 0.5), sim(12000, 0.75, 'grep-read-ranges'), [run(2000, 1000, 1200, 0.2, 0.3), run(4000, 2000, 2000, 0.6, 0.6)])];
  const full = report(tasks, [2000, 4000]);

  it('opens with the simulation notice and shows every section', () => {
    const text = renderMarkdown(full, aggregate(full));
    expect(text.split('\n').slice(0, 3)).toEqual(['# Maxify offline benchmark', '', `> ${OFFLINE_NOTICE}`]);
    for (const heading of ['## REGRESSION flags', '## Summary by budget', '## Tasks where Maxify cost more than a baseline', '## Per-task results, budget 2000', '## Per-task results, budget 4000', '## Methodology and limitations']) {
      expect(text).toContain(heading);
    }
    expect(text).toContain('**REGRESSION** budget 2000');
    expect(text).toContain('Cold index: 300 ms');
  });

  it('says so plainly when no regression exists', () => {
    const calm = report([task('t', sim(6000, 0.5), sim(12000, 0.5, 'grep-read-ranges'), [run(2000, 1000, 1000, 0.9, 0.9)])]);
    expect(renderMarkdown(calm, aggregate(calm))).toContain('none: no budget used fewer tokens than a baseline while resolving less');
  });

  it('marks Maxify columns n/a and explains why when the engine is unavailable', () => {
    const none = report([task('t', sim(6000, 0.5), sim(12000, 0.5, 'grep-read-ranges'), [])], [2000], false);
    const text = renderMarkdown(none, aggregate(none));
    expect(text).toContain('UNAVAILABLE (not built)');
    expect(text).toContain('n/a');
    expect(text).not.toContain('## REGRESSION flags');
  });

  it('escapes pipes in table cells', () => {
    const odd = report([task('t|x', sim(10, 1), sim(10, 1, 'grep-read-ranges'), [])], [2000], false);
    expect(renderMarkdown(odd, aggregate(odd))).toContain('t\\|x');
  });

  it('emits JSON with the aggregates attached', () => {
    const parsed = JSON.parse(renderJson(full, aggregate(full))) as { aggregates: { hasAggregateRegression: boolean }; tasks: unknown[]; notice: string };
    expect(parsed.notice).toBe(OFFLINE_NOTICE);
    expect(parsed.tasks).toHaveLength(1);
    expect(parsed.aggregates.hasAggregateRegression).toBe(true);
  });
});
