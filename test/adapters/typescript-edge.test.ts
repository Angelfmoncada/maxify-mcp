import { describe, expect, it } from 'vitest';
import { describeRefs, parseTs, qualNames, src, sym } from './helpers.js';

describe('typescript adapter: decorators and member names', () => {
  it('skips decorators and comments when rendering heads', () => {
    const file = parseTs(
      src(
        '@Entity()', // 1
        '// trailing comment', // 2
        '/* block */ class User {', // 3
        '  @Column() /* c */ name!: string;', // 4
        "  [Symbol.iterator]() {}", // 5
        "  'quoted-name'() {}", // 6
        '  42() {}', // 7
        '}', // 8
      ),
    );
    expect(sym(file, 'User').span.startLine).toBe(1);
    expect(sym(file, 'User').signature).toBe(
      src('class User {', '  name!: string', '  [Symbol.iterator]()', "  'quoted-name'()", '  42()', '}'),
    );
    expect(qualNames(file)).toEqual(['User', 'User.[Symbol.iterator]', 'User.quoted-name', 'User.42']);
  });
});

describe('typescript adapter: default export expressions', () => {
  it('handles class, function, wrapped and plain values', () => {
    const asClass = parseTs('export default (class Repo { find() {} });');
    expect(qualNames(asClass)).toEqual(['Repo', 'Repo.find']);
    expect(sym(asClass, 'Repo').exportNames).toEqual(['default']);
    expect(sym(asClass, 'Repo').signature).toBe('export default class Repo {\n  find()\n}');

    const asArrow = parseTs('export default async (req: Request) => { return req; };');
    expect(sym(asArrow, 'default')).toMatchObject({ kind: 'function', signature: 'export default async (req: Request) =>', flags: ['async', 'default-export'] });

    const named = parseTs('export default (function handler() {});');
    expect(sym(named, 'handler').exportNames).toEqual(['default']);

    const wrapped = parseTs('export default memo(() => <div />);', 'src/C.tsx');
    expect(sym(wrapped, 'default')).toMatchObject({ kind: 'component', signature: 'export default memo(() =>' });

    const plain = parseTs('export default connect(mapState)(Page);');
    expect(sym(plain, 'default')).toMatchObject({ kind: 'variable', signature: 'export default connect(mapState)(Page)' });
  });

  it('handles `export =` with expressions', () => {
    const file = parseTs('export = { parse(text: string) { return text; }, version: 1 };');
    expect(qualNames(file)).toEqual(['default', 'default.parse']);
    expect(sym(file, 'default').flags).toEqual(['default-export', 'export-equals']);
    expect(sym(file, 'default').signature).toBe('export = { parse(text: string) { return text; }, version: 1 }');
  });
});

describe('typescript adapter: JSDoc rendering', () => {
  it('renders template, type, optional param and unknown tags', () => {
    const file = parseTs(
      src(
        '/**',
        ' * Maps items.',
        ' * @template T, U',
        ' * @param {T[]} items - the items',
        ' * @param {string} [label] optional label',
        ' * @type {Mapper}',
        ' * @property {number} size the size',
        ' * @see {@link other}',
        ' */',
        'function map(items, label) {}',
      ),
      'src/map.js',
    );
    expect(sym(file, 'map').doc).toBe(
      [
        'Maps items.',
        '@template T, U',
        '@param items - the items',
        '@param [label] optional label',
        '@type {Mapper}',
        '@property {number} size the size',
        '@see {@link other}',
      ].join('\n'),
    );
  });

  it('documents variables from their statement and CommonJS exports from theirs', () => {
    const file = parseTs(src('/** Port number. */', 'export const port = 3000;', '/** Starts it. */', 'exports.start = () => {};'), 'src/s.js');
    expect(sym(file, 'port').doc).toBe('Port number.');
    expect(sym(file, 'port').span.startLine).toBe(1);
    expect(sym(file, 'start').doc).toBe('Starts it.');
  });
});

describe('typescript adapter: scope edge cases', () => {
  it('handles catch without binding, labels, switch blocks, hoisted vars and class expression names', () => {
    const file = parseTs(
      src(
        'function target() {}',
        'type Key = string;',
        'export function edge(input: unknown) {',
        '  try { target(); } catch { target(); }',
        '  outer: for (const k in obj) { if (k) break outer; }',
        '  switch (input) { case 1: { const target = 0; target; break; } default: target(); }',
        '  if (input) { var hoisted = target; }',
        '  const K = class target { m() { return target; } };',
        '  return hoisted ?? K;',
        '}',
        'type Mapped = { [Key in "a" | "b"]: Key };',
        'type Unwrap<T> = T extends Promise<infer Key> ? Key : T;',
        'type UsesKey = Record<Key, number>;',
      ),
    );
    expect(describeRefs(file)).toEqual([
      'edge -> target [calls] x3',
      'edge -> target [references]',
      'UsesKey -> Key [uses-type]',
    ]);
  });

  it('resolves names inside namespace bodies and enum-like objects', () => {
    const file = parseTs(
      src(
        'namespace Shapes {',
        '  export class Square {}',
        '  export function make() { return new Square(); }',
        '}',
        'export const sq = Shapes.make();',
        'type S = Shapes.Square;',
      ),
    );
    expect(describeRefs(file)).toEqual(['Shapes.make -> Shapes.Square [calls]', 'sq -> Shapes.make [calls]', 'S -> Shapes.Square [uses-type]']);
  });

  it('resolves exports.x and module.exports.x reads to CommonJS export symbols', () => {
    const file = parseTs(
      src(
        'exports.parse = (text) => text.trim();',
        'exports.load = (path) => exports.parse(read(path));',
        'module.exports.run = () => module.exports.load("x");',
        'function local(exports) { return exports.parse; }',
      ),
      'lib/cjs.js',
    );
    expect(describeRefs(file)).toEqual(['load -> parse [calls]', 'run -> load [calls]']);
  });

  it('does not bind `global` for global augmentations', () => {
    const file = parseTs(src('declare global { interface Window { app: App } }', 'export const g = global.process;'));
    expect(describeRefs(file)).toEqual([]);
    expect(file.symbols.map((s) => s.qualName)).toEqual(['global', 'global.Window', 'g']);
  });

  it('reports element access on namespaces with literal keys', () => {
    const file = parseTs(src("import * as icons from './icons';", "export const home = icons['home'];"));
    expect(describeRefs(file)).toEqual(['home -> ./icons#home [references]']);
  });
});
