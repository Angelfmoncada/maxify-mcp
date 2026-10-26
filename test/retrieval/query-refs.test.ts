import { describe, expect, it } from 'vitest';
import { identifierTerms, pathTerms, splitIdentifier } from '../../src/indexer/terms.js';
import { analyzeTask, ftsOr, ftsTerm, stem } from '../../src/retrieval/query.js';
import { parseLineRange, parseRef } from '../../src/retrieval/refs.js';

describe('identifier terms', () => {
  it('splits camelCase, PascalCase acronyms and snake_case', () => {
    expect(splitIdentifier('requireAuth')).toEqual(['require', 'auth']);
    expect(splitIdentifier('HTTPServer')).toEqual(['http', 'server']);
    expect(splitIdentifier('max_file_bytes')).toEqual(['max', 'file', 'bytes']);
  });

  it('builds deduplicated search terms including whole names', () => {
    expect(identifierTerms(['isExpired', 'Token.isExpired'])).toBe('is expired isexpired token tokenisexpired');
    expect(pathTerms('src/server/auth/token.ts')).toContain('auth');
  });
});

describe('analyzeTask', () => {
  it('extracts identifiers, paths, explicit refs and quoted messages', () => {
    const q = analyzeTask('Fix `isExpired` in src/server/auth/token.ts; see src/a.ts#Foo.bar and error "token expired"');
    expect(q.identifiers).toContain('isExpired');
    expect(q.paths).toContain('src/server/auth/token.ts');
    expect(q.refs).toContain('src/a.ts#Foo.bar');
    expect(q.quoted).toContain('token expired');
    expect(q.terms.map((t) => t.term)).toContain('isexpired');
  });

  it('drops stopwords in English and Spanish and keeps domain words', () => {
    const q = analyzeTask('Corrige el bug de expiración del token en el middleware');
    const terms = q.terms.map((t) => t.term);
    expect(terms).not.toContain('el');
    expect(terms).not.toContain('del');
    expect(terms.some((t) => t.startsWith('expir'))).toBe(true);
    expect(terms).toContain('token');
  });

  it('detects test, docs and config intents', () => {
    expect(analyzeTask('which tests cover the router?').intents.tests).toBe(true);
    expect(analyzeTask('update the README architecture docs').intents.docs).toBe(true);
    expect(analyzeTask('change the tsconfig paths').intents.config).toBe(true);
  });

  it('quotes FTS terms so task text cannot inject query syntax', () => {
    expect(ftsTerm({ term: 'a"b', prefix: false, weight: 1 })).toBe('"a""b"');
    expect(ftsOr([{ term: 'expir', prefix: true, weight: 1 }, { term: 'NEAR', prefix: false, weight: 1 }])).toBe('"expir"* OR "NEAR"');
  });

  it('stems common suffixes only when a 4+ char stem remains', () => {
    expect(stem('expiration')).toBe('expir');
    expect(stem('tokens')).toBe('token');
    expect(stem('uses')).toBe('uses');
  });
});

describe('parseRef', () => {
  it('parses every ref form', () => {
    expect(parseRef('blob:ABCDEF0123')).toEqual({ type: 'blob', hash: 'abcdef0123' });
    expect(parseRef('src/a.ts:10-20')).toEqual({ type: 'range', path: 'src/a.ts', start: 10, end: 20 });
    expect(parseRef('src/a.ts:7')).toEqual({ type: 'range', path: 'src/a.ts', start: 7, end: 7 });
    expect(parseRef('src/a.ts#L3-L9')).toEqual({ type: 'range', path: 'src/a.ts', start: 3, end: 9 });
    expect(parseRef('src/a.ts#Session.refresh')).toEqual({ type: 'symbol', path: 'src/a.ts', qual: 'Session.refresh' });
    expect(parseRef('#isExpired')).toEqual({ type: 'name', name: 'isExpired' });
    expect(parseRef('isExpired')).toEqual({ type: 'name', name: 'isExpired' });
    expect(parseRef('`src/a.ts`')).toEqual({ type: 'file', path: 'src/a.ts' });
    expect(parseRef('C:/repo/src/a.ts:5')).toEqual({ type: 'range', path: 'C:/repo/src/a.ts', start: 5, end: 5 });
  });

  it('rejects empty and inverted ranges', () => {
    expect(() => parseRef('')).toThrow();
    expect(() => parseRef('src/a.ts:20-10')).toThrow(/invalid line range/);
    expect(() => parseRef('src/a.ts#')).toThrow(/empty symbol/);
    expect(parseLineRange('5-9')).toEqual({ start: 5, end: 9 });
    expect(() => parseLineRange('x')).toThrow();
  });
});
