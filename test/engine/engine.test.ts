import { readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MaxifyError } from '../../src/core/errors.js';
import { openEngine } from '../../src/engine/engine.js';
import type { MaxifyEngine } from '../../src/engine/types.js';
import { fencedBlocks, MINI_REPO, writeRepo } from './fixture.js';

let root: string;
let stateDir: string;
let engine: MaxifyEngine;

beforeAll(async () => {
  root = writeRepo(MINI_REPO);
  stateDir = path.join(root, '..', `${path.basename(root)}-state`);
  engine = await openEngine({ root, stateDir });
});

afterAll(() => {
  engine.close();
  rmSync(root, { recursive: true, force: true });
  rmSync(stateDir, { recursive: true, force: true });
});

function fileText(rel: string): string {
  return readFileSync(path.join(root, ...rel.split('/')), 'utf8');
}

function assertExactBlocks(text: string): void {
  const corpus = Object.keys(MINI_REPO)
    .filter((p) => !p.startsWith('.env'))
    .map((p) => {
      try {
        return fileText(p);
      } catch {
        return '';
      }
    })
    .join('\n');
  for (const block of fencedBlocks(text)) expect(corpus).toContain(block);
}

describe('engine: index + context', () => {
  it('indexes the repo without reading secrets', async () => {
    const stats = await engine.stats({ scope: 'index' });
    expect(stats.text).toMatch(/files: .*indexed/);
    expect(stats.text).not.toContain('do-not-read');
  });

  it('returns exact source of the target symbol with its contract and test, within budget', async () => {
    const out = await engine.context({ task: 'Fix isExpired: a token should already be expired exactly at exp', budget: 3000 });
    expect(out.meta.estTokens).toBeLessThanOrEqual(3000 + 20);
    const refs = (out.meta.items ?? []).map((i) => `${i.ref}@${i.level}`);
    expect(refs).toContain('src/lib/token.ts#isExpired@source');
    expect(out.text).toContain('  return now > payload.exp;');
    expect(out.text).toContain('test/token.test.ts');
    expect(out.text).toMatch(/TokenPayload/);
    expect(out.text).not.toContain('do-not-read');
    assertExactBlocks(out.text);
  });

  it('never cuts code: tiny budgets yield a coherent, explicitly incomplete package', async () => {
    for (const budget of [300, 500, 800]) {
      const out = await engine.context({ task: 'how does requireAuth validate the token expiry?', budget });
      expect(out.meta.estTokens).toBeLessThanOrEqual(budget + 20);
      assertExactBlocks(out.text);
      if (!out.meta.complete) expect(out.text).toMatch(/INCOMPLETE|omitted/);
    }
  });

  it('links callers through a path alias and a barrel re-export (resolved)', async () => {
    const out = await engine.impact({ targets: ['src/lib/token.ts#verifyToken'] });
    expect(out.text).toContain('src/auth.ts');
    expect(out.text).toMatch(/requireAuth .*calls.*resolved/);
  });

  it('reports dynamic imports as uncertain instead of inventing targets', async () => {
    const out = await engine.context({ task: 'where are plugins loaded? loadPlugin', budget: 2000 });
    expect(out.text).toMatch(/uncertain[\s\S]*dynamic-import/);
  });

  it('serves cached results for identical requests at the same generation', async () => {
    const a = await engine.context({ task: 'verifyToken error handling', budget: 2000 });
    const b = await engine.context({ task: 'verifyToken error handling', budget: 2000 });
    expect(b.meta.cacheHit).toBe(true);
    expect(b.text).toBe(a.text);
  });
});

describe('engine: freshness, renames, deletions', () => {
  it('reflects an edit made right before the next query (evidence verified against disk)', async () => {
    const file = path.join(root, 'src', 'lib', 'token.ts');
    writeFileSync(file, fileText('src/lib/token.ts').replace('return now > payload.exp;', 'return now >= payload.exp;'));
    const out = await engine.context({ task: 'isExpired comparison', budget: 2000 });
    expect(out.text).toContain('return now >= payload.exp;');
    expect(out.text).not.toContain('return now > payload.exp;');
    const src = await engine.source({ ref: 'src/lib/token.ts#isExpired' });
    expect(src.text).toContain('return now >= payload.exp;');
  });

  it('detects renames by content hash and moves note refs along', async () => {
    const added = await engine.memory({ op: 'add', text: 'legacy check is unused', kind: 'fact', refs: ['src/legacy/old-auth.ts#checkTokenLegacy'] });
    const id = /\b(n[0-9a-f]{7})\b/.exec(added.text)?.[1] as string;
    renameSync(path.join(root, 'src', 'legacy', 'old-auth.ts'), path.join(root, 'src', 'legacy', 'auth-v1.ts'));
    const summary = await engine.index();
    expect(summary.renamed).toBe(1);
    const note = await engine.memory({ op: 'get', id });
    expect(note.text).toContain('src/legacy/auth-v1.ts#checkTokenLegacy');
    expect(note.text).toContain('current');
  });

  it('marks notes stale when referenced code changes', async () => {
    const added = await engine.memory({ op: 'add', text: 'auth uses seconds', refs: ['src/auth.ts#requireAuth'] });
    const id = /\b(n[0-9a-f]{7})\b/.exec(added.text)?.[1] as string;
    writeFileSync(path.join(root, 'src', 'auth.ts'), `${fileText('src/auth.ts')}\n// touched\n`);
    await engine.index();
    expect((await engine.memory({ op: 'get', id })).text).toContain('STALE');
  });

  it('drops deleted files from the index', async () => {
    unlinkSync(path.join(root, 'src', 'plugins.ts'));
    const summary = await engine.index();
    expect(summary.removed).toBe(1);
    await expect(engine.source({ ref: 'src/plugins.ts#loadPlugin' })).rejects.toThrow(MaxifyError);
  });
});

describe('engine: source, security, compression, cursor', () => {
  it('refuses secrets and paths outside the root', async () => {
    await expect(engine.source({ ref: '.env' })).rejects.toThrow(/secret/);
    await expect(engine.source({ ref: '../outside.ts' })).rejects.toThrow(/outside/);
    await expect(engine.compress({ path: '.env' })).rejects.toThrow(/secret/);
  });

  it('paginates long sources explicitly at line boundaries', async () => {
    const lines = Array.from({ length: 400 }, (_, i) => `export const value${i} = ${i}; // filler line ${i}`);
    writeFileSync(path.join(root, 'src', 'big.ts'), `${lines.join('\n')}\n`);
    await engine.index();
    const first = await engine.source({ ref: 'src/big.ts', maxTokens: 400 });
    expect(first.meta.complete).toBe(false);
    const next = /maxify_source ref=(src\/big\.ts:\d+-\d+)/.exec(first.text)?.[1] as string;
    expect(next).toBeTruthy();
    const second = await engine.source({ ref: next, maxTokens: 400 });
    const firstBlock = fencedBlocks(first.text)[0] as string;
    const secondBlock = fencedBlocks(second.text)[0] as string;
    expect(lines.join('\n').startsWith(firstBlock)).toBe(true);
    expect(lines.join('\n')).toContain(`${firstBlock}\n${secondBlock.split('\n')[0]}`);
  });

  it('compresses noisy output, keeps errors verbatim and returns the exact original by ref', async () => {
    const noisy = [
      ...Array.from({ length: 300 }, (_, i) => `2026-10-26T10:00:${String(i % 60).padStart(2, '0')}Z INFO processed batch ${i}`),
      'ERROR database connection refused at db.ts:42 (ECONNREFUSED 127.0.0.1:5432)',
      ...Array.from({ length: 50 }, (_, i) => `2026-10-26T10:05:00Z INFO retry ${i}`),
    ].join('\n');
    const out = await engine.compress({ text: noisy });
    expect(out.text).toContain('ERROR database connection refused at db.ts:42 (ECONNREFUSED 127.0.0.1:5432)');
    expect(out.meta.estTokens).toBeLessThan(2000);
    const ref = /blob:([0-9a-f]{12})/.exec(out.text)?.[1] as string;
    const back = await engine.compress({ ref: `blob:${ref}`, lines: '301-301' });
    expect(back.text).toContain('ERROR database connection refused at db.ts:42');
  });

  it('continues an incomplete package with a cursor without repeating delivered items', async () => {
    const first = await engine.context({ task: 'token verification, auth, expiry and tests', budget: 400 });
    if (!first.meta.cursor) return;
    const second = await engine.context({ task: 'token verification, auth, expiry and tests', cursor: first.meta.cursor });
    const firstSources = new Set((first.meta.items ?? []).filter((i) => i.level === 'source').map((i) => i.ref));
    for (const item of second.meta.items ?? []) if (item.level === 'source') expect(firstSources.has(item.ref)).toBe(false);
    expect(second.text).toContain('page 2');
  });

  it('delta mode (opt-in) replaces already-sent source by a short reference', async () => {
    await engine.context({ task: 'requireAuth', budget: 2000, delta: true });
    const again = await engine.context({ task: 'requireAuth', budget: 2000, delta: true });
    expect(again.text).toContain('already sent this session');
  });
});

describe('engine: isolation', () => {
  it('resets a state dir reused for another root instead of mixing indexes', async () => {
    const other = writeRepo({ 'src/other.ts': 'export function otherThing(): number {\n  return 1;\n}\n' }, 'maxify-other-');
    const shared = path.join(tmpdir(), `maxify-shared-${Date.now()}`);
    const a = await openEngine({ root, stateDir: shared });
    a.close();
    const b = await openEngine({ root: other, stateDir: shared });
    const out = await b.context({ task: 'requireAuth isExpired', budget: 1500 });
    expect(out.text).not.toContain('src/auth.ts');
    b.close();
    rmSync(other, { recursive: true, force: true });
    rmSync(shared, { recursive: true, force: true });
  });
});
