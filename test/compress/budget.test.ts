import { describe, expect, it } from 'vitest';
import { compress } from '../../src/compress/index.js';
import { estimateTokens } from '../../src/core/tokens.js';
import { apiResponse, checkMarkers, fixture, gitDiff, lsFiles, rgOutput, uncoveredLines } from './helpers.js';

/** Parses "» incomplete: … at L3-L5, L9" into 1-based line numbers. */
function incompleteLines(text: string): number[] {
  const line = text.split('\n').find((l) => l.startsWith('» incomplete:'));
  if (line === undefined) return [];
  const refs = /at ((?:L\d+(?:-L\d+)?(?:, )?)+)/.exec(line)?.[1] ?? '';
  return refs
    .split(', ')
    .filter((r) => r.length > 0)
    .flatMap((r) => {
      const [a, b] = r.split('-').map((x) => Number(x.slice(1)));
      const lo = a ?? 0;
      const hi = b ?? lo;
      return Array.from({ length: hi - lo + 1 }, (_, k) => lo + k);
    });
}

describe('fallbacks', () => {
  it('returns small inputs unchanged', () => {
    const text = 'Build started\nCompiling 3 files\nError: missing semicolon at src/a.ts:3\nBuild failed\n';
    const r = compress(text);
    expect(r).toMatchObject({ transform: 'none', fellBack: true, complete: true, text });
    expect(r.stats.criticalLines).toBeGreaterThan(0);
    expect(r.stats.criticalKept).toBe(r.stats.criticalLines);
    expect(r.notes.join(' ')).toMatch(/small/);
  });

  it('returns empty input unchanged', () => {
    const r = compress('');
    expect(r).toMatchObject({ transform: 'none', fellBack: true, text: '', kind: 'text' });
    expect(r.stats.originalLines).toBe(0);
  });

  it('falls back when compression would keep >= 85% (all tsc lines are errors)', () => {
    const text = fixture('tsc-errors.txt');
    const r = compress(text);
    expect(r.kind).toBe('text');
    expect(r).toMatchObject({ transform: 'none', fellBack: true, complete: true });
    expect(r.text).toBe(text);
    expect(r.notes.join(' ')).toMatch(/% of the original/);
  });

  it('compresses tsc output under a tighter budget without losing an error line', () => {
    const text = fixture('tsc-errors.txt');
    const r = compress(text, { maxTokens: 700 });
    expect(r.fellBack).toBe(false);
    const lines = new Set(r.text.split('\n'));
    for (const line of text.split('\n').filter((l) => /error TS\d+/.test(l))) {
      expect(lines.has(line) || incompleteLines(r.text).includes(text.split('\n').indexOf(line) + 1), line).toBe(true);
    }
    expect(r.text.split('\n')[0]).toMatch(/^summary: failure markers found/);
  });

  it('never returns more than the original when nothing compresses', () => {
    const lines = Array.from({ length: 200 }, (_, i) => `entry ${i}: the quick brown fox ${String.fromCharCode(97 + (i % 26))} jumps`);
    const text = lines.join('\n');
    const r = compress(text, { maxTokens: 100_000 });
    expect(r.stats.estOutputTokens).toBeLessThanOrEqual(r.stats.estOriginalTokens);
  });
});

describe('critical lines over budget', () => {
  const errors = Array.from({ length: 400 }, (_, i) => `2024-05-01T10:00:${String(i % 60).padStart(2, '0')}Z ERROR job ${i} failed: upstream returned 503 for shard ${i % 7}`);
  const noise = Array.from({ length: 400 }, (_, i) => `2024-05-01T10:01:00Z INFO heartbeat ok ${i}`);
  const text = errors.flatMap((e, i) => [e, noise[i] ?? '']).join('\n');
  const r = compress(text, { maxTokens: 600 });

  it('keeps what fits, lists the rest by line number and reports complete=false', () => {
    expect(r.complete).toBe(false);
    expect(r.stats.criticalKept).toBeLessThan(r.stats.criticalLines);
    expect(r.text).toMatch(/^» incomplete: \d+ of 400 critical lines not shown/m);
    expect(r.stats.estOutputTokens).toBeLessThanOrEqual(650);
  });

  it('accounts for every critical line: shown verbatim or inside a listed range', () => {
    const shown = new Set(r.text.split('\n'));
    const listed = new Set(incompleteLines(r.text));
    errors.forEach((e, k) => {
      expect(shown.has(e) || listed.has(k * 2 + 1), e).toBe(true);
    });
  });

  it('states the failure count first', () => {
    expect(r.text.split('\n')[0]).toMatch(/^summary: failure markers found: 400 lines/);
  });

  it('npm ERR! output keeps the real failure lines before prefix-only noise', () => {
    const npm = compress(fixture('npm-err.txt'));
    const lines = new Set(npm.text.split('\n'));
    expect(npm.complete).toBe(false);
    for (const want of [
      "npm ERR! ModuleNotFoundError: No module named 'distutils'",
      'npm ERR! gyp ERR! stack Error: `gyp` failed with exit code: 1',
      'npm ERR! Build failed with error code: 1',
      'npm ERR! A complete log of this run can be found in: /home/dev/.npm/_logs/2024-05-02T10_31_07_551Z-debug-0.log',
    ]) {
      expect(lines.has(want), want).toBe(true);
    }
    expect(npm.text).toMatch(/^summary: \d+ warning lines; 0 shown verbatim/m);
    expect(compress(fixture('npm-err.txt'), { maxTokens: 4000 }).complete).toBe(true);
  });
});

describe('focus terms', () => {
  it('keeps every line containing a focus term (case-insensitive)', () => {
    const text = Array.from({ length: 600 }, (_, i) => `2024-05-01T10:00:00Z INFO worker-${i % 50 === 7 ? 'gc' : i % 9} processed batch ${i}`).join('\n');
    const r = compress(text, { focus: ['WORKER-GC'] });
    const lines = new Set(r.text.split('\n'));
    const hits = text.split('\n').filter((l) => l.includes('worker-gc'));
    expect(hits.length).toBe(12);
    for (const h of hits) expect(lines.has(h)).toBe(true);
    expect(r.complete).toBe(true);
  });

  it('keeps focus hits in search results and listings', () => {
    const rg = rgOutput();
    const hits = rg.split('\n').filter((l) => l.includes('isAdmin'));
    const r = compress(rg, { focus: ['isadmin'], maxTokens: 4000 });
    expect(r.complete).toBe(true);
    const lines = new Set(r.text.split('\n'));
    for (const h of hits) expect(lines.has(h)).toBe(true);
    const ls = compress(lsFiles(), { focus: ['route3'] });
    expect(ls.text.split('\n')).toContain('packages/api/src/routes/route3.ts');
  });

  it('keeps focus hits inside diff files that are only listed', () => {
    const r = compress(gitDiff(), { focus: ['@babel/parser'], maxTokens: 900 });
    expect(r.text).toContain('"node_modules/@babel/parser": {');
    expect(r.complete).toBe(true);
  });

  it('ignores invalid focus input', () => {
    const text = fixture('vitest-fail.txt');
    expect(compress(text, { focus: ['', '   '] })).toEqual(compress(text));
  });
});

describe('diff budget', () => {
  it('shows whole files in order, then lists the rest with stats and line ranges', () => {
    const diff = gitDiff();
    const r = compress(diff, { maxTokens: 600 });
    expect(r.kind).toBe('diff');
    expect(r.text).toContain('» file src/cart/cart.js +9 -3 at L1-L41; git header L1-L4 (4 lines) omitted');
    expect(r.text.split('\n')).toContain('+    return roundMoney(subtotal * (1 - this.percentOff / 100));');
    expect(r.text).toMatch(/» file src\/cart\/__tests__\/cart\.test\.js \+8 -0 at L\d+-L\d+ \(over budget: contents omitted\)/);
    expect(r.text).toMatch(/» file package-lock\.json \+181 -181 at L\d+-L\d+ \(lockfile: contents omitted\)/);
    expect(r.text).not.toContain('"integrity": "sha512-');
    expect(checkMarkers(diff, r.text, { trim: false }).errors).toEqual([]);
    expect(uncoveredLines(diff, r.text)).toEqual([]);
  });

  it('parses a plain diff -u without git headers', () => {
    const plain = [
      '--- config/app.yml\t2024-05-01 10:00:00.000000000 +0200',
      '+++ config/app.yml\t2024-05-02 09:12:44.000000000 +0200',
      '@@ -1,3 +1,3 @@',
      ' server:',
      '-  port: 8080',
      '+  port: 9090',
      '   host: 0.0.0.0',
      ...Array.from({ length: 60 }, (_, i) => `--- a/notes-${i}.txt\n+++ b/notes-${i}.txt\n@@ -1 +1 @@\n-old line ${i} with some text to compress\n+new line ${i} with some text to compress`),
    ].join('\n');
    const r = compress(plain);
    expect(r.kind).toBe('diff');
    expect(r.text).toContain('» file config/app.yml +1 -1');
    expect(r.text.split('\n')).toContain('+  port: 9090');
  });
});

describe('search and list budgets', () => {
  it('shows verbatim match lines when the budget allows', () => {
    const rg = rgOutput();
    const r = compress(rg, { maxTokens: 3000 });
    const report = checkMarkers(rg, r.text);
    expect(report.errors).toEqual([]);
    // Identical match texts are shown once, so the distinct texts bound what is shown.
    const distinct = new Set(rg.split('\n').map((l) => l.replace(/^[^:]+:\d+:/, '').trim())).size - 1;
    expect(report.checked).toBe(distinct);
    expect(r.text).toMatch(/^» src\/hooks\/useAuth\.ts: 40 matches at L\d+-L\d+; source lines/m);
  });

  it('folds trailing files into one omission when even headers do not fit', () => {
    const rg = rgOutput();
    const r = compress(rg, { maxTokens: 300 });
    expect(r.text).toMatch(/omitted: \d+ lines \(\d+ more files with \d+ matches/);
    expect(uncoveredLines(rg, r.text)).toEqual([]);
    expect(r.stats.estOutputTokens).toBeLessThanOrEqual(300);
  });

  it('aggregates directories when exact directories do not fit', () => {
    const ls = lsFiles();
    const r = compress(ls, { maxTokens: 250 });
    expect(r.kind).toBe('list');
    expect(r.text).toMatch(/\/\*\* — \d+ entries/);
    expect(uncoveredLines(ls, r.text)).toEqual([]);
  });
});

describe('json', () => {
  const big = apiResponse(3000);
  const r = compress(big);

  it('summarizes structure and keeps error/status/message values verbatim', () => {
    expect(r).toMatchObject({ kind: 'json', transform: 'summary', complete: true, fellBack: false });
    expect(r.text).toContain('"status":"partial"');
    expect(r.text).toContain('"code":"E_RATE_LIMIT"');
    expect(r.text).toContain('"message":"Inventory service timed out after 5000ms (2 of 12 shards missing)"');
    expect(r.text).toContain('"status":"failed"');
    expect(r.text).toMatch(/\.data\[\*\]\.status ×1800 \(first L\d+\): "status":"active"/);
    expect(r.text).toContain('array[3000] of object{id: number, sku: string');
    expect(r.stats.estOutputTokens).toBeLessThanOrEqual(1200);
  });

  it('keeps big integers exactly as written', () => {
    expect(r.text).toContain('12345678901234567890123');
  });

  it('points structure lines at the original pretty-printed lines', () => {
    const lines = big.split('\n');
    const m = /» \.meta \(L(\d+)-L(\d+)\)/.exec(r.text);
    expect(m).not.toBeNull();
    expect(lines[Number(m?.[1]) - 1]?.trim()).toBe('"meta": {');
  });

  it('minifies small JSON losslessly (transform format)', () => {
    const small = apiResponse(5);
    const out = compress(small);
    expect(out.transform).toBe('format');
    expect(JSON.parse(out.text)).toEqual(JSON.parse(small));
    expect(out.text).toContain('"requestId":12345678901234567890123');
    expect(out.text).not.toContain('\n');
    expect(out.text).toContain('"message":"Rate limit exceeded for /v2/products; retry after 30s"');
    expect(out.stats.estOutputTokens).toBeLessThan(out.stats.estOriginalTokens * 0.85);
  });

  it('treats invalid JSON as text', () => {
    const broken = `{"items": [${Array.from({ length: 300 }, (_, i) => `{"id": ${i}, "name": "item ${i}"}`).join(',\n')}\n`;
    const out = compress(broken, { kind: 'json' });
    expect(out.kind).toBe('text');
    expect(out.notes.join(' ')).toMatch(/JSON\.parse failed/);
  });

  it('lists critical key/values that do not fit', () => {
    const items = Array.from({ length: 800 }, (_, i) => ({ id: i, error: { message: `shard ${i} failed with code E${1000 + i}` } }));
    const text = JSON.stringify({ items }, null, 2);
    const out = compress(text, { maxTokens: 400 });
    expect(out.complete).toBe(false);
    expect(out.text).toMatch(/» incomplete: \d+ of 800 critical key\/values not shown/);
    expect(out.stats.criticalKept).toBeLessThan(out.stats.criticalLines);
  });
});

describe('options and edge cases', () => {
  it('honours a requested kind', () => {
    const r = compress(fixture('vitest-fail.txt'), { kind: 'text' });
    expect(r.kind).toBe('text');
    expect(r.notes[0]).toBe('kind text (requested)');
  });

  it('falls back to text when a structured kind does not apply', () => {
    const log = fixture('webpack-build.txt');
    expect(compress(log, { kind: 'search' }).kind).toBe('text');
    expect(compress(log, { kind: 'list' }).kind).toBe('text');
    expect(compress(log, { kind: 'diff' }).kind).toBe('text');
  });

  it('clamps nonsensical budgets', () => {
    const text = fixture('vitest-fail.txt');
    expect(compress(text, { maxTokens: Number.NaN })).toEqual(compress(text));
    const tiny = compress(text, { maxTokens: 1 });
    expect(tiny.text.split('\n')[0]).toMatch(/^summary: FAILED/);
  });

  it('switches the marker when the input already has marker-like lines', () => {
    const text = Array.from({ length: 300 }, (_, i) => (i % 10 === 0 ? `» L${i} looks like a marker` : `line ${i} of plain text output with words`)).join('\n');
    const r = compress(text, { maxTokens: 300 });
    expect(r.text).toMatch(/^»» L\d+/m);
    expect(checkMarkers(text, r.text, { marker: '»»' }).errors).toEqual([]);
  });

  it('collapses carriage-return progress redraws to the last state', () => {
    const bar = Array.from({ length: 50 }, (_, i) => `Downloading ${i * 2}%`).join('\r');
    const words = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel'];
    const name = (i: number): string => `${words[i % 8] ?? ''}-${words[Math.floor(i / 8) % 8] ?? ''}`;
    const text = Array.from({ length: 60 }, (_, i) => `${name(i)}: ${bar}\r${name(i)}: installed`).join('\n');
    const r = compress(text, { maxTokens: 5000 });
    expect(r.transform).toBe('format');
    expect(r.text.split('\n')[0]).toBe('alpha-alpha: installed');
    expect(r.notes.join(' ')).toMatch(/progress redraws collapsed/);
  });

  it('keeps a redrawn line intact when an overwritten state was a failure', () => {
    const text = [
      ...Array.from({ length: 120 }, (_, i) => `2024-05-01T10:00:00Z INFO tick ${i}`),
      'progress 10%\rERROR: disk quota exceeded\rprogress 20%',
    ].join('\n');
    const r = compress(text);
    expect(r.text).toContain('ERROR: disk quota exceeded');
    expect(r.complete).toBe(true);
  });

  it('strips ANSI codes and reports it', () => {
    const r = compress(fixture('jest-fail.txt'));
    expect(r.text).not.toMatch(/\u001b/);
    expect(r.notes.join(' ')).toMatch(/ANSI codes stripped from 7 lines/);
  });

  it('never claims success for a passing summary next to an error line', () => {
    const text = [
      ...Array.from({ length: 60 }, (_, i) => ` ✓ src/m${i}.test.ts > works ${i} 1ms`),
      'Error: connect ECONNREFUSED 127.0.0.1:5432',
      ' Test Files  60 passed (60)',
      '      Tests  60 passed (60)',
    ].join('\n');
    const r = compress(text);
    expect(r.kind).toBe('test');
    expect(r.text.split('\n')[0]).toMatch(/^summary: FAILURE MARKERS FOUND/);
    expect(r.text).not.toMatch(/^summary: PASSED/m);
  });

  it('reports PASSED only for clean runs', () => {
    const text = [
      ' RUN  v2.1.8 /home/dev/app',
      ...Array.from({ length: 80 }, (_, i) => ` ✓ src/m${i}.test.ts (${i + 1} tests) ${i}ms`),
      ' Test Files  80 passed (80)',
      '      Tests  3240 passed (3240)',
    ].join('\n');
    const r = compress(text);
    expect(r.text.split('\n')[0]).toBe('summary: PASSED — 0 failed, 3240 passed (vitest, L83)');
    expect(estimateTokens(r.text)).toBeLessThan(r.stats.estOriginalTokens * 0.5);
  });
});
