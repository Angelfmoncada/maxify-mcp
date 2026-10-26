import { describe, expect, it } from 'vitest';
import { jsonAdapter } from '../../src/adapters/json.js';
import { src } from './helpers.js';

const parse = (text: string, path = 'config/settings.json') => jsonAdapter.parse(path, text);

describe('json adapter: top-level keys', () => {
  const file = parse(
    src(
      '{', // 1
      '  "name": "demo",', // 2
      '  "nested": {', // 3
      '    "a": 1,', // 4
      '    "b": [1, 2]', // 5
      '  },', // 6
      '  "list": [', // 7
      '    1, 2, 3', // 8
      '  ],', // 9
      '  "flag": true', // 10
      '}', // 11
    ),
  );

  it('creates one key symbol per top-level key with exact spans', () => {
    expect(file.symbols.map((s) => [s.qualName, s.kind, s.span.startLine, s.span.endLine, s.parent])).toEqual([
      ['name', 'key', 2, 2, null],
      ['nested', 'key', 3, 6, null],
      ['list', 'key', 7, 9, null],
      ['flag', 'key', 10, 10, null],
    ]);
    expect(file.language).toBe('json');
    expect(file.imports).toEqual([]);
    expect(file.unresolved).toEqual([]);
  });

  it('renders short values in the signature', () => {
    expect(file.symbols.map((s) => s.signature)).toEqual([
      '"name": "demo"',
      '"nested": { "a": 1, "b": [1, 2] }',
      '"list": [1, 2, 3]',
      '"flag": true',
    ]);
  });

  it('summarizes long values within 100 characters', () => {
    const keys = Array.from({ length: 30 }, (_, i) => `"dependency-${i}": "^1.0.${i}"`);
    const long = parse(
      src('{', `  "deps": { ${keys.join(', ')} },`, `  "items": [${Array.from({ length: 60 }, (_, i) => i).join(', ')}],`, `  "text": "${'y'.repeat(150)}"`, '}'),
    );
    const [deps, items, text] = long.symbols.map((s) => s.signature);
    expect(deps?.startsWith('"deps": { dependency-0, dependency-1,')).toBe(true);
    expect(deps?.endsWith('}')).toBe(true);
    expect(deps?.length).toBeLessThanOrEqual(100);
    expect(items).toBe('"items": [ 60 items ]');
    expect(text?.length).toBe(100);
    expect(text?.endsWith('…')).toBe(true);
  });

  it('tolerates comments and trailing commas', () => {
    const jsonc = parse(src('{', '  // comment', '  "a": 1,', '}'), '.vscode/settings.json');
    expect(jsonc.symbols.map((s) => s.qualName)).toEqual(['a']);
  });

  it('de-duplicates repeated keys', () => {
    expect(parse('{ "a": 1, "a": 2 }').symbols.map((s) => s.qualName)).toEqual(['a', 'a~2']);
  });
});

describe('json adapter: package.json and tsconfig', () => {
  it('adds nested symbols for scripts, bin and exports', () => {
    const file = parse(
      src(
        '{',
        '  "name": "pkg",',
        '  "main": "dist/index.js",',
        '  "types": "dist/index.d.ts",',
        '  "bin": { "pkg": "dist/cli.js" },',
        '  "exports": { ".": "./dist/index.js", "./utils": { "import": "./dist/utils.js" } },',
        '  "scripts": {',
        '    "build": "tsc -p tsconfig.build.json",',
        '    "test": "vitest run"',
        '  }',
        '}',
      ),
      'package.json',
    );
    expect(file.symbols.map((s) => s.qualName)).toEqual([
      'name',
      'main',
      'types',
      'bin',
      'bin.pkg',
      'exports',
      'exports..',
      'exports../utils',
      'scripts',
      'scripts.build',
      'scripts.test',
    ]);
    const build = file.symbols.find((s) => s.qualName === 'scripts.build');
    expect(build).toMatchObject({ name: 'build', signature: '"build": "tsc -p tsconfig.build.json"', span: { startLine: 8, endLine: 8 } });
    expect(build?.parent).toBe(8);
    expect(file.symbols[1]?.signature).toBe('"main": "dist/index.js"');
  });

  it('keeps long script commands up to 300 characters', () => {
    const command = `node ${'a'.repeat(200)}`;
    const file = parse(`{ "scripts": { "long": "${command}" } }`, 'package.json');
    expect(file.symbols[1]?.signature).toBe(`"long": "${command}"`);
  });

  it('adds compilerOptions.paths entries for tsconfig files', () => {
    const file = parse(
      src('{', '  "compilerOptions": {', '    "strict": true,', '    "paths": {', '      "@/*": ["src/*"]', '    }', '  }', '}'),
      'tsconfig.base.json',
    );
    expect(file.symbols.map((s) => [s.qualName, s.parent, s.signature])).toEqual([
      ['compilerOptions', null, '"compilerOptions": { "strict": true, "paths": { "@/*": ["src/*"] } }'],
      ['compilerOptions.paths', 0, '"paths": { "@/*": ["src/*"] }'],
      ['compilerOptions.paths.@/*', 1, '"@/*": ["src/*"]'],
    ]);
  });

  it('only indexes top-level keys of files over 2,000 lines', () => {
    const scripts = Array.from({ length: 2100 }, (_, i) => `    "s${i}": "run ${i}",`);
    const file = parse(src('{', '  "scripts": {', ...scripts, '    "last": "x"', '  }', '}'), 'package.json');
    expect(file.symbols.map((s) => s.qualName)).toEqual(['scripts']);
  });
});

describe('json adapter: invalid and unusual input', () => {
  it('reports invalid JSON without symbols', () => {
    const file = parse(src('{', '  "a": 1', '  "b": }'));
    expect(file.symbols).toEqual([]);
    expect(file.unresolved).toEqual([{ line: 3, kind: 'parse-error', detail: "',' expected." }]);
  });

  it('returns nothing for empty files and chunks for non-object roots', () => {
    expect(parse('   \n')).toEqual({ language: 'json', isTest: false, symbols: [], imports: [], refs: [], unresolved: [] });
    const array = parse('[\n  1,\n  2\n]');
    expect(array.symbols.map((s) => [s.kind, s.qualName])).toEqual([['chunk', 'L1-4']]);
  });
});
