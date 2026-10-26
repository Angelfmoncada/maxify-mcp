import { describe, expect, it } from 'vitest';
import { countLines, findSymbol, listSymbols } from '../../src/bench/oracle.js';
import { LEVELS, formatRef, isLevel, levelRank, parseRef, refPath } from '../../src/bench/refs.js';

describe('parseRef', () => {
  it('reads file, symbol and range references', () => {
    expect(parseRef('src/a.ts')).toEqual({ kind: 'file', path: 'src/a.ts' });
    expect(parseRef('src/a.ts#Service.update')).toEqual({ kind: 'symbol', path: 'src/a.ts', symbol: 'Service.update' });
    expect(parseRef('src/a.ts:10-20')).toEqual({ kind: 'range', path: 'src/a.ts', startLine: 10, endLine: 20 });
    expect(parseRef('src/a.ts:7')).toEqual({ kind: 'range', path: 'src/a.ts', startLine: 7, endLine: 7 });
  });

  it('keeps test titles with spaces and arrows intact', () => {
    expect(parseRef('test/a.test.ts#suite > rejects expired token')).toEqual({
      kind: 'symbol',
      path: 'test/a.test.ts',
      symbol: 'suite > rejects expired token',
    });
  });

  it('rejects empty parts and inverted ranges', () => {
    expect(() => parseRef('')).toThrow();
    expect(() => parseRef('#Name')).toThrow();
    expect(() => parseRef('src/a.ts#')).toThrow();
    expect(() => parseRef('src/a.ts:20-10')).toThrow(/range/);
    expect(() => parseRef('src/a.ts:0-3')).toThrow(/range/);
  });

  it('round-trips through formatRef and exposes the path', () => {
    for (const ref of ['src/a.ts', 'src/a.ts#X.y', 'src/a.ts:3-9']) expect(formatRef(parseRef(ref))).toBe(ref);
    expect(refPath('src/a.ts#X.y')).toBe('src/a.ts');
  });
});

describe('levels', () => {
  it('orders source above signature above map', () => {
    expect(levelRank('source')).toBeGreaterThan(levelRank('signature'));
    expect(levelRank('signature')).toBeGreaterThan(levelRank('map'));
    expect(LEVELS).toEqual(['map', 'signature', 'source']);
    expect(isLevel('source')).toBe(true);
    expect(isLevel('full')).toBe(false);
  });
});

const SAMPLE = [
  '/** Doc for the class. */',
  'export class Service {',
  '  private readonly items = new Map<string, number>();',
  '',
  '  constructor(seed: number) {',
  '    this.items.set("seed", seed);',
  '  }',
  '',
  '  update(id: string): number {',
  '    return this.items.get(id) ?? 0;',
  '  }',
  '}',
  '',
  'export interface Options {',
  '  retries: number;',
  '}',
  '',
  'export const LIMIT = 5, OTHER = 6;',
  'export function helper(): void {}',
  '',
  "describe('suite', () => {",
  "  it('does a thing', () => {",
  '    helper();',
  '  });',
  '});',
  '',
].join('\n');

describe('oracle', () => {
  it('resolves classes, members, interfaces, variables and functions with exact line ranges', () => {
    const find = (name: string) => findSymbol('src/sample.ts', SAMPLE, name);
    expect(find('Service')).toMatchObject({ startLine: 2, endLine: 12, kind: 'class' });
    expect(find('Service.constructor')).toMatchObject({ startLine: 5, endLine: 7 });
    expect(find('Service.update')).toMatchObject({ startLine: 9, endLine: 11 });
    expect(find('Options')).toMatchObject({ startLine: 14, endLine: 16, kind: 'interface' });
    expect(find('Options.retries')).toMatchObject({ startLine: 15, endLine: 15 });
    expect(find('LIMIT')).toMatchObject({ startLine: 18, endLine: 18 });
    expect(find('helper')).toMatchObject({ startLine: 19, endLine: 19, kind: 'function' });
    expect(find('Missing')).toBeUndefined();
  });

  it('names tests with the documented "suite > title" convention', () => {
    const names = listSymbols('test/sample.test.ts', SAMPLE).map((symbol) => symbol.qualName);
    expect(names).toContain('suite');
    expect(names).toContain('suite > does a thing');
  });

  it('resolves markdown sections by heading text up to the next heading of the same or higher level', () => {
    const text = ['# Title', 'intro', '## Part A', 'a', '### Deep', 'd', '## Part B', 'b', ''].join('\n');
    const find = (name: string) => findSymbol('docs/x.md', text, name);
    expect(find('Title')).toMatchObject({ startLine: 1, endLine: 8 });
    expect(find('Part A')).toMatchObject({ startLine: 3, endLine: 6 });
    expect(find('Deep')).toMatchObject({ startLine: 5, endLine: 6 });
    expect(find('Part B')).toMatchObject({ startLine: 7, endLine: 8 });
  });

  it('ignores headings inside code fences and unknown file types', () => {
    const text = ['# Real', '```', '# not a heading', '```', ''].join('\n');
    expect(listSymbols('x.md', text).map((symbol) => symbol.qualName)).toEqual(['Real']);
    expect(listSymbols('data.json', '{"a":1}')).toEqual([]);
  });

  it('understands CommonJS functions', () => {
    const text = ["'use strict';", 'function escapeCell(v) {', '  return v;', '}', 'module.exports = { escapeCell };', ''].join('\n');
    expect(findSymbol('lib/x.cjs', text, 'escapeCell')).toMatchObject({ startLine: 2, endLine: 4 });
  });

  it('counts lines without counting the trailing newline', () => {
    expect(countLines('')).toBe(0);
    expect(countLines('a\nb\n')).toBe(2);
    expect(countLines('a\nb')).toBe(2);
    expect(countLines('a\r\nb\r\n')).toBe(2);
  });
});
