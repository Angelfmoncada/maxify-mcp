import { describe, expect, it } from 'vitest';
import { TOOL_RESULT_OVERHEAD_TOKENS, estimateTokens } from '../../src/core/tokens.js';
import { scoreSim } from '../../src/bench/baselines.js';
import { callCost, sumTokens } from '../../src/bench/cost.js';
import {
  GREP_READ_FILE_COUNT,
  MAX_WINDOWS,
  WINDOW_RADIUS,
  grepFiles,
  renderCatN,
  simulateGrepReadFiles,
  simulateGrepReadRanges,
} from '../../src/bench/native-sim.js';
import { resolveRequirement } from '../../src/bench/scoring.js';

function body(total: number, hits: Record<number, string>): string {
  return Array.from({ length: total }, (_, index) => hits[index + 1] ?? `filler line ${index + 1}`).join('\n');
}

describe('cat -n rendering and grep', () => {
  it('right-aligns the line number to 6 columns and separates it with a tab', () => {
    expect(renderCatN(['a', 'b'], 9)).toBe('     9\ta\n    10\tb');
  });

  it('matches case-insensitively, reports 1-based lines and visits files in sorted order', () => {
    const files = new Map([
      ['src/z.ts', 'nothing\nALPHA here'],
      ['src/a.ts', 'Alpha first\nbeta second'],
    ]);
    const hits = grepFiles(files, ['alpha', 'beta']);
    expect(hits.map((hit) => `${hit.path}:${hit.line}`)).toEqual(['src/a.ts:1', 'src/a.ts:2', 'src/z.ts:2']);
    expect(hits[0]?.matched).toEqual(['alpha']);
  });
});

describe('cost accounting', () => {
  it('adds argument, result and the fixed per-call overhead', () => {
    const cost = callCost('grep', 'grep -rn alpha .', 'src/a.ts:1:alpha');
    expect(cost.tokens).toBe(estimateTokens('grep -rn alpha .') + estimateTokens('src/a.ts:1:alpha') + TOOL_RESULT_OVERHEAD_TOKENS);
    expect(sumTokens([cost, cost])).toBe(cost.tokens * 2);
  });
});

describe('simulateGrepReadFiles (A)', () => {
  const files = new Map<string, string>([
    ['src/one.ts', body(40, { 5: 'alpha beta', 6: 'alpha' })],
    ['src/two.ts', body(30, { 3: 'alpha' })],
    ['src/three.ts', body(30, { 3: 'alpha beta' })],
    ['src/four.ts', body(30, { 3: 'alpha' })],
    ['src/none.ts', body(10, {})],
  ]);

  it('reads the top three files ranked by distinct keywords, then hit lines, then path', () => {
    const outcome = simulateGrepReadFiles(files, 'alpha beta');
    expect(outcome.keywords).toEqual(['alpha', 'beta']);
    expect(outcome.reads).toEqual(['src/one.ts', 'src/three.ts', 'src/four.ts']);
    expect(outcome.calls).toBe(1 + GREP_READ_FILE_COUNT);
  });

  it('shows every matching file in the listing as map-level evidence and reads as source-level', () => {
    const outcome = simulateGrepReadFiles(files, 'alpha beta');
    const mapPaths = outcome.evidence.filter((item) => item.level === 'map').map((item) => item.path);
    expect(mapPaths).toEqual(['src/one.ts', 'src/three.ts', 'src/four.ts', 'src/two.ts']);
    const read = outcome.evidence.find((item) => item.level === 'source' && item.path === 'src/one.ts');
    expect(read).toMatchObject({ startLine: 1, endLine: 40 });
  });

  it('charges the listing and every read, and the total is the sum of the calls', () => {
    const outcome = simulateGrepReadFiles(files, 'alpha beta');
    expect(outcome.tokens).toBe(sumTokens(outcome.perCall));
    expect(outcome.perCall[1]?.argTokens).toBe(estimateTokens('cat -n src/one.ts'));
    expect(outcome.perCall.every((call) => call.tokens >= TOOL_RESULT_OVERHEAD_TOKENS)).toBe(true);
  });

  it('costs one grep call and reads nothing when there is no match', () => {
    const outcome = simulateGrepReadFiles(files, 'zzzzzz');
    expect(outcome.calls).toBe(1);
    expect(outcome.evidence).toEqual([]);
    expect(outcome.reads).toEqual([]);
  });

  it('is deterministic and independent of map insertion order', () => {
    const shuffled = new Map([...files].reverse());
    expect(simulateGrepReadFiles(shuffled, 'alpha beta')).toEqual(simulateGrepReadFiles(files, 'alpha beta'));
  });
});

describe('simulateGrepReadRanges (B)', () => {
  it('merges overlapping windows around nearby hits into one read', () => {
    const files = new Map([['src/a.ts', body(200, { 100: 'alpha', 120: 'alpha' })]]);
    const outcome = simulateGrepReadRanges(files, 'alpha');
    expect(outcome.reads).toEqual([`src/a.ts:${100 - WINDOW_RADIUS}-${120 + WINDOW_RADIUS}`]);
    expect(outcome.calls).toBe(2);
  });

  it('keeps far-apart hits in separate windows and clips windows to the file', () => {
    const files = new Map([['src/a.ts', body(200, { 10: 'alpha', 195: 'alpha' })]]);
    const outcome = simulateGrepReadRanges(files, 'alpha');
    expect(outcome.reads).toEqual([`src/a.ts:1-${10 + WINDOW_RADIUS}`, `src/a.ts:${195 - WINDOW_RADIUS}-200`]);
  });

  it('reads at most MAX_WINDOWS windows, preferring path order among equals', () => {
    const files = new Map(
      Array.from({ length: 12 }, (_, index): [string, string] => [`src/f${String(index).padStart(2, '0')}.ts`, body(60, { 30: 'alpha' })]),
    );
    const outcome = simulateGrepReadRanges(files, 'alpha');
    expect(outcome.reads).toHaveLength(MAX_WINDOWS);
    expect(outcome.reads[0]).toMatch(/^src\/f00\.ts:/);
    expect(outcome.reads.at(-1)).toMatch(/^src\/f07\.ts:/);
  });

  it('prefers windows that contain more distinct keywords', () => {
    const files = new Map<string, string>([
      ['src/a.ts', body(100, { 10: 'alpha' })],
      ['src/b.ts', body(100, { 10: 'alpha beta' })],
    ]);
    const outcome = simulateGrepReadRanges(files, 'alpha beta');
    expect(outcome.reads).toHaveLength(2);
    const first = simulateGrepReadRanges(new Map([...files]), 'alpha beta');
    expect(first).toEqual(outcome);
  });

  it('puts the hit lines of the chosen windows into the listing, capped by the listing limit', () => {
    const files = new Map([['src/a.ts', body(300, Object.fromEntries(Array.from({ length: 150 }, (_, index) => [index * 2 + 1, 'alpha'])))]]);
    const outcome = simulateGrepReadRanges(files, 'alpha');
    const listing = outcome.perCall[0];
    expect(listing?.resultTokens).toBeGreaterThan(0);
    expect(outcome.tokens).toBe(sumTokens(outcome.perCall));
  });
});

describe('scoreSim', () => {
  const file = ['export function target() {', '  return 1;', '}', ...Array.from({ length: 80 }, (_, index) => `// padding ${index}`), 'export function decoy() {}', ''].join('\n');
  const files = new Map([
    ['src/a.ts', file],
    ['src/legacy.ts', 'export const old = 1;\n'],
  ]);

  it('credits full reads and punishes windows that miss the symbol', () => {
    const requirements = [resolveRequirement({ ref: 'src/a.ts#target', level: 'source' }, files)];
    const whole = scoreSim(simulateGrepReadFiles(files, 'target'), requirements, []);
    expect(whole.recall).toBe(1);
    const partial = scoreSim(
      { strategy: 'grep-read-ranges', keywords: [], perCall: [], tokens: 0, calls: 0, reads: [], evidence: [{ path: 'src/a.ts', startLine: 2, endLine: 3, level: 'source' }] },
      requirements,
      [],
    );
    expect(partial.recall).toBe(0);
    expect(partial.missed).toEqual(['src/a.ts#target']);
  });

  it('counts a forbidden file only when it was read, not when it is merely listed', () => {
    const requirements = [resolveRequirement({ ref: 'src/a.ts#target', level: 'map' }, files)];
    const listedOnly = scoreSim(
      { strategy: 'grep-read-files', keywords: [], perCall: [], tokens: 0, calls: 0, reads: [], evidence: [{ path: 'src/legacy.ts', startLine: 1, endLine: 1, level: 'map' }] },
      requirements,
      ['src/legacy.ts'],
    );
    expect(listedOnly.forbiddenRead).toEqual([]);
    const read = scoreSim(
      { strategy: 'grep-read-files', keywords: [], perCall: [], tokens: 0, calls: 0, reads: [], evidence: [{ path: 'src/legacy.ts', startLine: 1, endLine: 1, level: 'source' }] },
      requirements,
      ['src/legacy.ts'],
    );
    expect(read.forbiddenRead).toEqual(['src/legacy.ts']);
  });
});
