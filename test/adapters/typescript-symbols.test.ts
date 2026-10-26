import { describe, expect, it } from 'vitest';
import { parseTs, qualNames, src, sym, symbolIndex } from './helpers.js';

describe('typescript adapter: symbol kinds', () => {
  const file = parseTs(
    src(
      'export function plain(a: number): number { return a; }', // 1
      'export class Session {', // 2
      '  private token = "x";', // 3
      '  static create(): Session { return new Session(); }', // 4
      '  constructor(private store: Store) {}', // 5
      '  get expired(): boolean { return false; }', // 6
      '  set expired(v: boolean) {}', // 7
      '  async refresh(): Promise<void> {}', // 8
      '  onTick = () => this.refresh();', // 9
      '  #secret() {}', // 10
      '}', // 11
      'export interface Options { a: string }', // 12
      'export type Id = string;', // 13
      'export enum Color { Red, Green }', // 14
      'export namespace Geo { export function dist(): number { return 0; } }', // 15
      'export const VERSION = "1.0";', // 16
      'export const double = (n: number) => n * 2;', // 17
      'export const triple = function (n: number) { return n * 3; };', // 18
      'export const api = { list() { return 1; }, get: async (id: string) => id, plain: 3 };', // 19
      'const { left, right: renamed } = pair();', // 20
      'let counter = 0, other;', // 21
      'const Klass = class { run() {} };', // 22
    ),
  );

  it('emits one symbol per declaration with the expected kind', () => {
    const kinds = Object.fromEntries(file.symbols.map((s) => [s.qualName, s.kind]));
    expect(kinds).toEqual({
      plain: 'function',
      Session: 'class',
      'Session.create': 'method',
      'Session.constructor': 'constructor',
      'Session.expired': 'accessor',
      'Session.expired~2': 'accessor',
      'Session.refresh': 'method',
      'Session.onTick': 'property',
      'Session.#secret': 'method',
      Options: 'interface',
      Id: 'type',
      Color: 'enum',
      Geo: 'namespace',
      'Geo.dist': 'function',
      VERSION: 'variable',
      double: 'function',
      triple: 'function',
      api: 'variable',
      'api.list': 'method',
      'api.get': 'method',
      left: 'variable',
      renamed: 'variable',
      counter: 'variable',
      other: 'variable',
      Klass: 'class',
      'Klass.run': 'method',
    });
  });

  it('links members to their parent symbol', () => {
    const session = symbolIndex(file, 'Session');
    expect(sym(file, 'Session.refresh').parent).toBe(session);
    expect(sym(file, 'Session.onTick').parent).toBe(session);
    expect(sym(file, 'api.get').parent).toBe(symbolIndex(file, 'api'));
    expect(sym(file, 'Geo.dist').parent).toBe(symbolIndex(file, 'Geo'));
    expect(sym(file, 'plain').parent).toBeNull();
  });

  it('records member flags', () => {
    expect(sym(file, 'Session.create').flags).toEqual(['static']);
    expect(sym(file, 'Session.refresh').flags).toEqual(['async']);
    expect(sym(file, 'Session.expired').flags).toEqual(['get']);
    expect(sym(file, 'Session.expired~2').flags).toEqual(['set']);
    expect(sym(file, 'Session.#secret').flags).toEqual(['private']);
    expect(sym(file, 'api.get').flags).toEqual(['async']);
  });

  it('keeps document order with parents before children', () => {
    expect(qualNames(file).slice(0, 10)).toEqual([
      'plain',
      'Session',
      'Session.create',
      'Session.constructor',
      'Session.expired',
      'Session.expired~2',
      'Session.refresh',
      'Session.onTick',
      'Session.#secret',
      'Options',
    ]);
    file.symbols.forEach((s, i) => {
      if (s.parent !== null) expect(s.parent).toBeLessThan(i);
    });
  });

  it('does not create symbols for plain class properties or nested functions', () => {
    expect(qualNames(file)).not.toContain('Session.token');
    expect(qualNames(file)).not.toContain('api.plain');
  });

  it('gives multi-declarator statements one symbol per name with tight spans', () => {
    expect(sym(file, 'counter').span).toEqual({ startLine: 21, endLine: 21 });
    expect(sym(file, 'renamed').span).toEqual({ startLine: 20, endLine: 20 });
  });
});

describe('typescript adapter: components and hooks', () => {
  const file = parseTs(
    src(
      "import { memo, forwardRef, type FC } from 'react';",
      'export function Button({ label }: { label: string }) { return <button>{label}</button>; }',
      'export const Card = (props: Props) => <div>{props.title}</div>;',
      'export const Plain = () => 42;',
      'export const Typed: FC<Props> = (p) => null;',
      'export const Wrapped = memo(function Wrapped() { return <span />; });',
      'export const Input = forwardRef<HTMLInputElement, Props>((props, ref) => <input ref={ref} />);',
      'export function useCounter(start = 0) { return start; }',
      'export const useStore = create(() => ({}));',
      'function renderRow() { return <tr />; }',
      'export default function () { return <main />; }',
    ),
    'src/ui.tsx',
  );

  it('classifies PascalCase JSX functions and FC-typed values as components', () => {
    expect(sym(file, 'Button').kind).toBe('component');
    expect(sym(file, 'Card').kind).toBe('component');
    expect(sym(file, 'Typed').kind).toBe('component');
    expect(sym(file, 'Wrapped').kind).toBe('component');
    expect(sym(file, 'Input').kind).toBe('component');
    expect(sym(file, 'default').kind).toBe('component');
    expect(sym(file, 'Plain').kind).toBe('function');
  });

  it('classifies use* functions as hooks', () => {
    expect(sym(file, 'useCounter').kind).toBe('hook');
    expect(sym(file, 'useStore').kind).toBe('hook');
  });

  it('flags functions that render JSX', () => {
    expect(sym(file, 'Button').flags).toContain('jsx');
    expect(sym(file, 'renderRow').flags).toEqual(['jsx']);
    expect(sym(file, 'renderRow').kind).toBe('function');
    expect(sym(file, 'Plain').flags).not.toContain('jsx');
  });
});

describe('typescript adapter: spans, docs and flags', () => {
  const file = parseTs(
    src(
      '/**', // 1
      ' * Refreshes the session.', // 2
      ' * @param token the refresh token', // 3
      ' * @returns nothing', // 4
      ' * @deprecated use renew()', // 5
      ' */', // 6
      'export async function* refresh(token: string) {', // 7
      '  yield token;', // 8
      '}', // 9
      '', // 10
      '@Component({', // 11
      "  selector: 'app',", // 12
      '})', // 13
      'export abstract class Widget {', // 14
      '  /** Draws it. */', // 15
      '  @Input() abstract draw(): void;', // 16
      '  protected readonly size = 1;', // 17
      '  declare label: string;', // 18
      '}', // 19
      '// plain comment', // 20
      'export declare function external(): void;', // 21
    ),
  );

  it('starts spans at the leading JSDoc comment', () => {
    expect(sym(file, 'refresh').span).toEqual({ startLine: 1, endLine: 9 });
  });

  it('starts spans at decorators and member docs', () => {
    expect(sym(file, 'Widget').span).toEqual({ startLine: 11, endLine: 19 });
    expect(sym(file, 'Widget.draw').span).toEqual({ startLine: 15, endLine: 16 });
  });

  it('does not extend spans over plain comments', () => {
    expect(sym(file, 'external').span).toEqual({ startLine: 21, endLine: 21 });
  });

  it('renders JSDoc text and tags without comment markers', () => {
    expect(sym(file, 'refresh').doc).toBe(
      'Refreshes the session.\n@param token the refresh token\n@returns nothing\n@deprecated use renew()',
    );
    expect(sym(file, 'Widget.draw').doc).toBe('Draws it.');
    expect(sym(file, 'external').doc).toBe('');
  });

  it('records async, generator, deprecated, abstract and declare flags', () => {
    expect(sym(file, 'refresh').flags).toEqual(['async', 'generator', 'deprecated']);
    expect(sym(file, 'Widget').flags).toEqual(['abstract']);
    expect(sym(file, 'Widget.draw').flags).toEqual(['abstract']);
    expect(sym(file, 'external').flags).toEqual(['declare']);
  });

  it('truncates long docs to 400 characters', () => {
    const long = parseTs(src(`/** ${'word '.repeat(200)} */`, 'function f() {}'));
    expect(sym(long, 'f').doc.length).toBeLessThanOrEqual(400);
    expect(sym(long, 'f').doc.endsWith('…')).toBe(true);
  });

  it('ignores file-level doc comments', () => {
    const header = parseTs(src('/** @file Utilities. */', '', '/** Real doc. */', 'export function f() {}'));
    expect(sym(header, 'f').doc).toBe('Real doc.');
    expect(sym(header, 'f').span.startLine).toBe(3);
  });
});

describe('typescript adapter: qualName uniqueness', () => {
  it('suffixes overloads and duplicates in declaration order', () => {
    const file = parseTs(
      src(
        'export function over(a: string): string;',
        'export function over(a: number): number;',
        'export function over(a: unknown) { return a; }',
        'namespace NS { export const x = 1; }',
        'namespace NS { export const x = 2; }',
      ),
    );
    expect(qualNames(file)).toEqual(['over', 'over~2', 'over~3', 'NS', 'NS.x', 'NS~2', 'NS.x~2']);
    expect(file.symbols.slice(0, 3).map((s) => s.span.startLine)).toEqual([1, 2, 3]);
  });

  it('never collides with names that already carry a suffix', () => {
    const file = parseTs(src("describe('a', () => {});", "describe('a~2', () => {});", "describe('a', () => {});"));
    expect(qualNames(file)).toEqual(['a', 'a~2', 'a~3']);
  });

  it('names nested namespaces with dots', () => {
    const file = parseTs(src('declare module "pkg" { interface Ext {} }', 'namespace A.B { export type T = 1; }'));
    expect(qualNames(file)).toEqual(['pkg', 'pkg.Ext', 'A.B', 'A.B.T']);
    expect(sym(file, 'pkg').flags).toEqual(['declare']);
  });
});
