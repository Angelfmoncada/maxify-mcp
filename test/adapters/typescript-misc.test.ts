import { describe, expect, it } from 'vitest';
import { typescriptAdapter } from '../../src/adapters/typescript.js';
import { parseTs, qualNames, src, sym } from './helpers.js';

describe('typescript adapter: module-level blocks', () => {
  it('groups consecutive non-declaration statements and labels them', () => {
    const file = parseTs(
      src(
        "import express from 'express';", // 1
        "'use strict';", // 2
        'const app = express();', // 3
        "app.get('/tasks', list);", // 4
        "app.post('/tasks', create);", // 5
        'if (process.env.DEBUG) { app.use(logger()); }', // 6
        'function list() {}', // 7
        'function create() {}', // 8
        'for (const r of routes) app.use(r);', // 9
        'try { start(); } catch {}', // 10
        'app.locals.title = "Tasks";', // 11
        '(async () => { await boot(); })();', // 12
        "require('./side-effect');", // 13
        'new Server(app).listen(3000);', // 14
      ),
    );
    expect(qualNames(file)).toEqual(['app', 'block@L4', 'list', 'create', 'block@L9', 'block@L14']);
    expect(sym(file, 'block@L4')).toMatchObject({
      kind: 'block',
      name: "app.get('/tasks')",
      span: { startLine: 4, endLine: 6 },
      signature: "app.get('/tasks')\napp.post('/tasks')\nif (process.env.DEBUG)",
    });
    expect(sym(file, 'block@L9').signature).toBe(
      'for (const r of routes)\ntry\napp.locals.title = "Tasks"\n(…)()',
    );
    expect(sym(file, 'block@L14').name).toBe('new Server(app).listen(3000)');
  });

  it('splits long runs at statement boundaries into blocks of at most 60 lines', () => {
    const calls = Array.from({ length: 130 }, (_, i) => `register('route${i}');`);
    const file = parseTs(src(...calls));
    expect(file.symbols.map((s) => [s.qualName, s.span.startLine, s.span.endLine])).toEqual([
      ['block@L1', 1, 60],
      ['block@L61', 61, 120],
      ['block@L121', 121, 130],
    ]);
    expect(sym(file, 'block@L1').signature.split('\n')).toHaveLength(21);
    expect(sym(file, 'block@L1').signature.split('\n')[20]).toBe('/* … 40 more statements */');
  });

  it('keeps a single statement longer than 60 lines in one block', () => {
    const body = Array.from({ length: 70 }, (_, i) => `  step${i}();`);
    const file = parseTs(src('if (ready) {', ...body, '}', 'done();'));
    expect(file.symbols.map((s) => [s.qualName, s.span.startLine, s.span.endLine])).toEqual([
      ['block@L1', 1, 72],
      ['block@L73', 73, 73],
    ]);
  });

  it('truncates block names to 60 characters', () => {
    const file = parseTs(`configure(${JSON.stringify('x'.repeat(100))});`);
    expect(file.symbols[0]?.name.length).toBeLessThanOrEqual(60);
  });
});

describe('typescript adapter: unresolved constructs', () => {
  const file = parseTs(
    src(
      'const name = pick();', // 1
      'import(`./locales/${name}.json`);', // 2
      'const mod = require(name);', // 3
      'eval("1 + 1");', // 4
      'const fn = new Function("a", "return a");', // 5
      "const pages = import.meta.glob('./pages/*.tsx');", // 6
      "const ctx = require.context('./icons', true);", // 7
      'handlers[event.type](event);', // 8
      'handlers[event.type].call(null, event);', // 9
      'module.exports[name] = fn;', // 10
      "obj['literal']();", // 11
      'list[0]();', // 12
    ),
    'src/dynamic.js',
  );

  it('reports each kind with line and verbatim excerpt', () => {
    expect(file.unresolved).toEqual([
      { line: 2, kind: 'dynamic-import', detail: 'import(`./locales/${name}.json`)' },
      { line: 3, kind: 'dynamic-require', detail: 'require(name)' },
      { line: 4, kind: 'eval', detail: 'eval("1 + 1")' },
      { line: 5, kind: 'eval', detail: 'new Function("a", "return a")' },
      { line: 6, kind: 'glob-import', detail: "import.meta.glob('./pages/*.tsx')" },
      { line: 7, kind: 'glob-import', detail: "require.context('./icons', true)" },
      { line: 8, kind: 'computed-call', detail: 'handlers[event.type](event)' },
      { line: 9, kind: 'computed-call', detail: 'handlers[event.type].call(null, event)' },
      { line: 10, kind: 'commonjs-dynamic', detail: 'module.exports[name] = fn' },
    ]);
  });

  it('does not import computed specifiers', () => {
    expect(file.imports).toEqual([]);
  });

  it('caps excerpts at 160 characters', () => {
    const long = parseTs(`eval(${JSON.stringify('x'.repeat(300))});`);
    expect(long.unresolved[0]?.detail.length).toBe(160);
  });
});

describe('typescript adapter: broken code', () => {
  it('never throws and reports the first syntax error', () => {
    const file = parseTs(src('export function ok() { return 1; }', 'const x = ;', 'function broken( {', 'export const after = 2;'));
    expect(file.unresolved[0]).toEqual({ line: 2, kind: 'parse-error', detail: 'Expression expected.' });
    expect(file.unresolved.filter((u) => u.kind === 'parse-error')).toHaveLength(1);
    expect(qualNames(file)).toContain('ok');
    expect(qualNames(file)).toContain('x');
  });

  it('survives garbage input', () => {
    const inputs = ['', '}}}{{{', 'class { ', '<<<<<<< HEAD\nconst a = 1;\n=======\n', '@', 'import', 'export default', '`unterminated ${'];
    for (const input of inputs) {
      expect(() => parseTs(input)).not.toThrow();
      expect(() => parseTs(input, 'src/x.tsx')).not.toThrow();
    }
  });

  it('degrades gracefully on pathologically deep nesting', () => {
    const deep = `const x = ${'('.repeat(3000)}1${')'.repeat(3000)};`;
    const file = parseTs(deep);
    expect(Array.isArray(file.symbols)).toBe(true);
  });
});

describe('typescript adapter: languages and determinism', () => {
  it('derives the language from the extension', () => {
    expect(typescriptAdapter.parse('a.ts', '').language).toBe('typescript');
    expect(typescriptAdapter.parse('a.mts', '').language).toBe('typescript');
    expect(typescriptAdapter.parse('a.cts', '').language).toBe('typescript');
    expect(typescriptAdapter.parse('a.tsx', '').language).toBe('typescript');
    expect(typescriptAdapter.parse('a.js', '').language).toBe('javascript');
    expect(typescriptAdapter.parse('a.jsx', '').language).toBe('javascript');
    expect(typescriptAdapter.parse('a.mjs', '').language).toBe('javascript');
    expect(typescriptAdapter.parse('a.cjs', '').language).toBe('javascript');
  });

  it('parses JSX in .js files', () => {
    const file = parseTs('export const App = () => <main />;', 'src/App.js');
    expect(sym(file, 'App').kind).toBe('component');
  });

  it('produces deep-equal output for the same input', () => {
    const source = src(
      "import { a } from './a';",
      'export class K { m() { return a(); } }',
      "describe('x', () => { it('y', () => {}); });",
      'run();',
    );
    expect(parseTs(source)).toEqual(parseTs(source));
    expect(JSON.stringify(parseTs(source))).toBe(JSON.stringify(parseTs(source)));
  });

  it('parses a 5,000-line file quickly', () => {
    const chunk = [
      '/** Loads an item. */',
      'export async function load(id: string): Promise<number> {',
      '  const value = await api.fetchItem(id);',
      '  return helper(value.count);',
      '}',
      'export class Store {',
      '  private items = new Map<string, number>();',
      '  add(key: string, value: number): void { this.items.set(key, value); }',
      '}',
      "app.get('/items', handler);",
    ];
    const lines = ["import * as api from './api';"];
    while (lines.length < 5000) lines.push(...chunk);
    const text = lines.join('\n');
    parseTs('const warmup = 1;');
    const started = performance.now();
    const file = parseTs(text, 'src/big.ts');
    const elapsed = performance.now() - started;
    expect(file.symbols.length).toBeGreaterThan(1000);
    // Generous bound: coverage instrumentation slows parsing ~3x; this still catches quadratic behavior.
    expect(elapsed).toBeLessThan(3000);
  });
});
