import { rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openEngine } from '../../src/engine/engine.js';
import type { MaxifyEngine } from '../../src/engine/types.js';
import { MINI_REPO, writeRepo } from './fixture.js';

let root: string;
let stateDir: string;
let engine: MaxifyEngine;

beforeAll(async () => {
  root = writeRepo(MINI_REPO, 'maxify-more-');
  stateDir = `${root}-state`;
  engine = await openEngine({ root, stateDir });
});

afterAll(() => {
  engine.close();
  rmSync(root, { recursive: true, force: true });
  rmSync(stateDir, { recursive: true, force: true });
});

function noteId(text: string): string {
  return /\b(n[0-9a-f]{7})\b/.exec(text)?.[1] as string;
}

describe('memory operations', () => {
  it('adds, lists, searches, updates and deletes notes with provenance', async () => {
    const added = await engine.memory({ op: 'add', text: 'verifyToken throws on expiry', kind: 'fact', origin: 'user', refs: ['src/lib/token.ts#verifyToken', 'src/auth.ts'] });
    const id = noteId(added.text);
    expect(added.text).toMatch(/fact · user · .* · current/);
    expect((await engine.memory({ op: 'list' })).text).toContain(id);
    expect((await engine.memory({ op: 'search', query: 'expiry' })).text).toContain(id);
    expect((await engine.memory({ op: 'search', query: 'src/auth.ts' })).text).toContain(id);
    expect((await engine.memory({ op: 'search', query: 'unrelated-zzz' })).text).toContain('no notes match');
    const updated = await engine.memory({ op: 'update', id, text: 'verifyToken rejects expired tokens', kind: 'decision' });
    expect(updated.text).toMatch(/decision · user/);
    expect((await engine.memory({ op: 'delete', id })).text).toContain(`deleted ${id}`);
    await expect(engine.memory({ op: 'get', id })).rejects.toThrow(/No note/);
  });

  it('validates input: text length, refs and ops', async () => {
    await expect(engine.memory({ op: 'add', text: '' })).rejects.toThrow(/required/);
    await expect(engine.memory({ op: 'add', text: 'x'.repeat(1001) })).rejects.toThrow(/1000/);
    await expect(engine.memory({ op: 'add', text: 'ok', refs: ['missing/file.ts'] })).rejects.toThrow(/not in the index/);
    await expect(engine.memory({ op: 'add', text: 'ok', refs: ['src/auth.ts#nope'] })).rejects.toThrow(/No symbol/);
    await expect(engine.memory({ op: 'add', text: 'ok', refs: ['blob:abcdef12'] })).rejects.toThrow(/refs must be/);
    await expect(engine.memory({ op: 'search' })).rejects.toThrow(/query is required/);
    await expect(engine.memory({ op: 'update' })).rejects.toThrow(/id is required/);
    await expect(engine.memory({ op: 'bogus' as 'list' })).rejects.toThrow(/op must be one of/);
  });

  it('surfaces relevant notes inside maxify_context, labelled as not verified source', async () => {
    await engine.memory({ op: 'add', text: 'requireAuth returns the token subject', refs: ['src/auth.ts#requireAuth'] });
    const out = await engine.context({ task: 'requireAuth subject', budget: 3000 });
    expect(out.text).toContain('notes — agent/user-authored, not verified source');
  });
});

describe('engine validation and other tools', () => {
  it('rejects malformed requests with clear messages', async () => {
    await expect(engine.context({ task: '' })).rejects.toThrow(/task/);
    await expect(engine.context({ task: 'x', detail: 'all' as 'map' })).rejects.toThrow(/detail must be one of/);
    await expect(engine.context({ task: 'x', cursor: 'nope' })).rejects.toThrow(/cursor/);
    await expect(engine.context({ task: 'x', cursor: 'c000000000000' })).rejects.toThrow(/unknown or expired/);
    await expect(engine.impact({ targets: [] })).rejects.toThrow(/at least one/);
    await expect(engine.compress({})).rejects.toThrow(/exactly one/);
    await expect(engine.compress({ ref: 'blob:zz' })).rejects.toThrow(/blob:HASH/);
    await expect(engine.compress({ ref: 'blob:0123456789ab' })).rejects.toThrow(/unknown/);
    await expect(engine.stats({ scope: 'everything' as 'all' })).rejects.toThrow(/scope/);
  });

  it('honours detail ceilings and focus refs, and reports unknown focus refs as uncertain', async () => {
    const mapOnly = await engine.context({ task: 'isExpired', detail: 'map', budget: 2000 });
    expect((mapOnly.meta.items ?? []).every((i) => i.level === 'map')).toBe(true);
    const focused = await engine.context({ task: 'check this', focus: ['src/auth.ts#requireAuth', 'src/missing.ts'], budget: 2000 });
    expect(focused.text).toContain('requireAuth');
    expect(focused.text).toMatch(/focus-not-found/);
  });

  it('returns a no-match answer instead of guessing', async () => {
    const out = await engine.context({ task: 'zzqx qqzv', budget: 1000 });
    expect(out.text).toContain('no matches');
    expect(out.meta.complete).toBe(false);
  });

  it('answers impact for a whole file and lists heuristic tests', async () => {
    const out = await engine.impact({ targets: ['src/lib/token.ts'], depth: 3 });
    expect(out.text).toContain('## direct dependents');
    expect(out.text).toContain('test/token.test.ts');
    expect(out.text).toMatch(/exported API surface/);
  });

  it('lists candidates for an ambiguous bare name instead of picking one', async () => {
    writeFileSync(path.join(root, 'src', 'dup.ts'), 'export function requireAuth(): void {\n  return;\n}\n');
    await engine.index();
    const out = await engine.source({ ref: 'requireAuth' });
    expect(out.text).toMatch(/matches 2 symbols/);
    expect(out.text).toContain('src/dup.ts#requireAuth');
  });

  it('reports stats with limitations and local session metrics', async () => {
    const out = await engine.stats();
    expect(out.text).toContain('## index');
    expect(out.text).toContain('## limitations');
    expect(out.text).toMatch(/maxify_context: \d+ calls/);
  });

  it('runs a full re-index on request', async () => {
    const summary = await engine.index({ full: true });
    expect(summary.updated + summary.unchanged).toBeGreaterThan(0);
    expect(summary.errors).toEqual([]);
  });
});
