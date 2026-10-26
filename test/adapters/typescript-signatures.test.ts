import { describe, expect, it } from 'vitest';
import { parseTs, src, sym } from './helpers.js';

describe('typescript adapter: function signatures', () => {
  it('keeps modifiers and drops the body', () => {
    const file = parseTs('export async function requireAuth(req: Request, next: Next): Promise<void> { await next(); }');
    expect(sym(file, 'requireAuth').signature).toBe('export async function requireAuth(req: Request, next: Next): Promise<void>');
  });

  it('collapses multi-line parameter lists and strips comments and trailing commas', () => {
    const file = parseTs(
      src(
        'export function create(',
        '  name: string, // the display name',
        '  /* options */ opts: {',
        '    force?: boolean;',
        '  } = {},',
        '): Widget {',
        '  return new Widget(name, opts);',
        '}',
      ),
    );
    expect(sym(file, 'create').signature).toBe('export function create(name: string, opts: { force?: boolean; } = {}): Widget');
  });

  it('keeps string and template literals intact', () => {
    const file = parseTs('function f(sep = "a  b", t = `x ${1}  y`) {}');
    expect(sym(file, 'f').signature).toBe('function f(sep = "a  b", t = `x ${1}  y`)');
  });

  it('renders overloads without a trailing semicolon', () => {
    const file = parseTs(src('export function over(a: string): string;', 'export function over(a: unknown) { return a; }'));
    expect(sym(file, 'over').signature).toBe('export function over(a: string): string');
    expect(sym(file, 'over~2').signature).toBe('export function over(a: unknown)');
  });

  it('renders default exports', () => {
    const file = parseTs('export default function () { return 1; }');
    expect(sym(file, 'default').signature).toBe('export default function ()');
  });

  it('renders function-valued consts up to the arrow', () => {
    const file = parseTs(
      src(
        'export const load = async (id: string): Promise<Item> => {',
        '  return fetchItem(id);',
        '};',
        'const legacy = function named(a) { return a; };',
      ),
    );
    expect(sym(file, 'load').signature).toBe('export const load = async (id: string): Promise<Item> =>');
    expect(sym(file, 'legacy').signature).toBe('const legacy = function named(a)');
  });
});

describe('typescript adapter: class signatures', () => {
  it('lists one line per member signature', () => {
    const file = parseTs(
      src(
        '@Injectable()',
        'export class Session extends Base implements Disposable {',
        '  private readonly cache: Map<string, Token> = new Map();',
        '  count = 0;',
        '  [key: string]: unknown;',
        '  static create(): Session { return new Session(); }',
        '  constructor(private store: Store, ttl?: number) { super(); }',
        '  get expired(): boolean { return false; }',
        '  async refresh(token: string): Promise<void> {}',
        '  onTick = (n: number) => this.refresh(String(n));',
        '  static { init(); }',
        '}',
      ),
    );
    expect(sym(file, 'Session').signature).toBe(
      src(
        'export class Session extends Base implements Disposable {',
        '  private readonly cache: Map<string, Token>',
        '  count',
        '  [key: string]: unknown',
        '  static create(): Session',
        '  constructor(private store: Store, ttl?: number)',
        '  get expired(): boolean',
        '  async refresh(token: string): Promise<void>',
        '  onTick = (n: number) =>',
        '}',
      ),
    );
    expect(sym(file, 'Session.constructor').signature).toBe('constructor(private store: Store, ttl?: number)');
    expect(sym(file, 'Session.onTick').signature).toBe('onTick = (n: number) =>');
  });

  it('caps very large classes with an explicit marker', () => {
    const members = Array.from({ length: 65 }, (_, i) => `  m${i}() {}`);
    const file = parseTs(src('class Big {', ...members, '}'));
    const lines = sym(file, 'Big').signature.split('\n');
    expect(lines).toHaveLength(63);
    expect(lines[61]).toBe('  /* … 5 more members */');
  });

  it('prefixes class expressions with their binding', () => {
    const file = parseTs('export const Klass = class extends Base { run(): void {} };');
    expect(sym(file, 'Klass').signature).toBe('export const Klass = class extends Base {\n  run(): void\n}');
  });
});

describe('typescript adapter: type signatures', () => {
  it('uses the verbatim declaration for small interfaces, aliases and enums', () => {
    const file = parseTs(
      src(
        '/** Options. */',
        'export interface Options {',
        '  a: string;',
        '  b?: number;',
        '}',
        'export type Id = string | number;',
        'export const enum Color { Red, Green = 2 }',
      ),
    );
    expect(sym(file, 'Options').signature).toBe('export interface Options {\n  a: string;\n  b?: number;\n}');
    expect(sym(file, 'Id').signature).toBe('export type Id = string | number;');
    expect(sym(file, 'Color').signature).toBe('export const enum Color { Red, Green = 2 }');
  });

  it('summarizes interfaces longer than 40 lines with a member marker', () => {
    const members = Array.from({ length: 45 }, (_, i) => `  field${i}: string;`);
    const file = parseTs(src('export interface Big {', ...members, '}'));
    const lines = sym(file, 'Big').signature.split('\n');
    expect(lines).toHaveLength(40);
    expect(lines[0]).toBe('export interface Big {');
    expect(lines[1]).toBe('  field0: string;');
    expect(lines[38]).toBe('  /* … 8 more members */');
    expect(lines[39]).toBe('}');
  });

  it('collapses multi-line members of long interfaces to one line each', () => {
    const members = Array.from({ length: 15 }, (_, i) => [`  m${i}(`, '    a: string,', '  ): void;']).flat();
    const file = parseTs(src('interface Wide {', ...members, '}'));
    const lines = sym(file, 'Wide').signature.split('\n');
    expect(lines).toHaveLength(17);
    expect(lines[1]).toBe('  m0(a: string): void;');
  });

  it('summarizes long unions and enums', () => {
    const union = Array.from({ length: 50 }, (_, i) => `  | 'v${i}'`);
    const enumMembers = Array.from({ length: 50 }, (_, i) => `  K${i} = ${i},`);
    const file = parseTs(src('export type Kind =', ...union, ';', 'enum E {', ...enumMembers, '}'));
    const kind = sym(file, 'Kind').signature.split('\n');
    expect(kind[0]).toBe('export type Kind =');
    expect(kind[1]).toBe("  | 'v0'");
    expect(kind[kind.length - 1]).toBe('  /* … 12 more members */');
    expect(kind).toHaveLength(40);
    const e = sym(file, 'E').signature.split('\n');
    expect(e[1]).toBe('  K0 = 0,');
    expect(e[e.length - 1]).toBe('}');
  });

  it('falls back to the first lines for other long type aliases', () => {
    const body = Array.from({ length: 45 }, (_, i) => `  T extends ${i} ? 'n${i}' :`);
    const file = parseTs(src('type Pick<T> =', ...body, '  never;'));
    const lines = sym(file, 'Pick').signature.split('\n');
    expect(lines).toHaveLength(40);
    expect(lines[39]).toBe('/* … 8 more lines */');
  });
});

describe('typescript adapter: variable and namespace signatures', () => {
  it('shows the type annotation, a short initializer or only the name', () => {
    const file = parseTs(
      src(
        'export const port: number = 3000;',
        "export const VERSION = '1.0';",
        'const flags = { a: true, b: [1, 2] } as const;',
        'export let db = new Client({ url: process.env.DB_URL });',
        'const handlers = { onClick: () => 1 };',
        `const long = '${'x'.repeat(100)}';`,
        'declare const injected: string;',
        'let pending!: Promise<void>;',
      ),
    );
    expect(sym(file, 'port').signature).toBe('export const port: number');
    expect(sym(file, 'VERSION').signature).toBe("export const VERSION = '1.0'");
    expect(sym(file, 'flags').signature).toBe('const flags = { a: true, b: [1, 2] } as const');
    expect(sym(file, 'db').signature).toBe('export let db = new Client({ url: process.env.DB_URL })');
    expect(sym(file, 'handlers').signature).toBe('const handlers');
    expect(sym(file, 'long').signature).toBe('const long');
    expect(sym(file, 'injected').signature).toBe('declare const injected: string');
    expect(sym(file, 'pending').signature).toBe('let pending!: Promise<void>');
  });

  it('renders destructuring patterns and namespaces', () => {
    const file = parseTs(src('export const { a, b: c } = pair;', 'export declare namespace Lib.Util { const x: number; }'));
    expect(sym(file, 'a').signature).toBe('export const { a, b: c } = pair');
    expect(sym(file, 'c').signature).toBe('export const { a, b: c } = pair');
    expect(sym(file, 'Lib.Util').signature).toBe('export declare namespace Lib.Util');
  });

  it('renders object literal members', () => {
    const file = parseTs('export const api = { async list(page = 1) { return page; }, get: (id: string): Item => find(id) };');
    expect(sym(file, 'api.list').signature).toBe('async list(page = 1)');
    expect(sym(file, 'api.get').signature).toBe('get: (id: string): Item =>');
  });
});
