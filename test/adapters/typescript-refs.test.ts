import { describe, expect, it } from 'vitest';
import { describeRefs, parseTs, src, symbolIndex } from './helpers.js';

describe('typescript adapter: reference kinds', () => {
  const file = parseTs(
    src(
      "import { render, type Props } from './lib';", // 1
      "import * as UI from './ui';", // 2
      "import Base from './base';", // 3
      'interface Shape extends Props {}', // 4
      'class Circle extends Base implements Shape {', // 5
      '  area(): number { return compute(this); }', // 6
      '}', // 7
      'function compute(c: Circle): number { return 1; }', // 8
      'export function App(props: Props) {', // 9
      '  const shape = new Circle();', // 10
      '  render(compute(shape), UI.theme);', // 11
      '  render(compute(shape));', // 12
      '  return <UI.Panel title="x"><Circle /><div /></UI.Panel>;', // 13
      '}', // 14
      'const tag = UI.css`color: red`;', // 15
    ),
    'src/app.tsx',
  );

  it('classifies calls, renders, heritage, types and plain references', () => {
    expect(describeRefs(file)).toEqual([
      'Shape -> ./lib#Props [extends]',
      'Circle -> ./base#default [extends]',
      'Circle -> Shape [implements]',
      'Circle.area -> compute [calls]',
      'compute -> Circle [uses-type]',
      'App -> ./lib#Props [uses-type]',
      'App -> Circle [calls]',
      'App -> ./lib#render [calls] x2',
      'App -> compute [calls] x2',
      'App -> ./ui#theme [references]',
      'App -> ./ui#Panel [renders]',
      'App -> Circle [renders]',
      'tag -> ./ui#css [calls]',
    ]);
  });

  it('records the first line and the merged count', () => {
    const renderRef = file.refs.find((r) => r.target.type === 'import' && r.target.name === 'render');
    expect(renderRef).toMatchObject({ from: symbolIndex(file, 'App'), kind: 'calls', line: 11, count: 2 });
  });
});

describe('typescript adapter: reference attribution', () => {
  it('attributes module-scope code to blocks and leaves export statements at module scope', () => {
    const file = parseTs(
      src("import express from 'express';", 'const app = express();', "app.get('/x', handler);", 'function handler() {}', 'export default app;'),
    );
    expect(describeRefs(file)).toEqual([
      'app -> express#default [calls]',
      'block@L3 -> app [references]',
      'block@L3 -> handler [references]',
      '<module> -> app [references]',
    ]);
  });

  it('resolves this.member and ClassName.member to sibling members', () => {
    const file = parseTs(
      src(
        'class Store {',
        '  static instance = () => Store.create();',
        '  static create() { return new Store(); }',
        '  load() { return this.parse(this.raw); }',
        '  parse(x: string) { const f = function () { return this.load(); }; return x; }',
        '  onTick = () => this.load();',
        '}',
      ),
    );
    expect(describeRefs(file)).toEqual([
      'Store.instance -> Store.create [calls]',
      'Store.create -> Store [calls]',
      'Store.load -> Store.parse [calls]',
      'Store.onTick -> Store.load [calls]',
    ]);
  });

  it('resolves members of local objects and namespaces', () => {
    const file = parseTs(
      src(
        'const api = { list() { return this.get(); }, get: () => 1 };',
        'namespace Geo { export function norm() { return 1; } export function dist() { return norm(); } }',
        'export function run() { return api.list() + Geo.dist(); }',
      ),
    );
    expect(describeRefs(file)).toEqual([
      'api.list -> api.get [calls]',
      'Geo.dist -> Geo.norm [calls]',
      'run -> api.list [calls]',
      'run -> Geo.dist [calls]',
    ]);
  });

  it('maps namespace and require bindings to member names', () => {
    const file = parseTs(
      src(
        "const fs = require('fs');",
        "import * as path from 'path';",
        'export function read(p) { return fs.readFileSync(path.join(p, "x"), "utf8"); }',
        'export function nsOnly() { return path; }',
        'export function local() { const util = require("util"); return util.format("%s", 1); }',
        "export const lazy = async () => { const m = await import('./m'); return m.run(); };",
      ),
      'src/io.js',
    );
    expect(describeRefs(file)).toEqual([
      'read -> fs#readFileSync [calls]',
      'read -> path#join [calls]',
      'nsOnly -> path#* [references]',
      'local -> util#format [calls]',
      'lazy -> ./m#run [calls]',
    ]);
  });

  it('records uses-type for type positions, typeof queries and import types', () => {
    const file = parseTs(
      src(
        "import type { User } from './user';",
        'const defaults = { a: 1 };',
        'type Defaults = typeof defaults;',
        'type Pair<T> = [T, User];',
        "type Cfg = import('./cfg').Config;",
      ),
    );
    expect(describeRefs(file)).toEqual([
      'Defaults -> defaults [uses-type]',
      'Pair -> ./user#User [uses-type]',
      'Cfg -> ./cfg#Config [uses-type]',
    ]);
  });
});

describe('typescript adapter: names that are not references', () => {
  it('skips declarations, property names, object keys and JSX attributes', () => {
    const file = parseTs(
      src(
        'const title = "t";',
        'function value() { return 1; }',
        'export function View() {',
        '  const obj = { title: 1, value };',
        '  obj.title = 2;',
        '  return <div title="x" value={title} />;',
        '}',
      ),
      'src/view.tsx',
    );
    expect(describeRefs(file)).toEqual(['View -> value [references]', 'View -> title [references]']);
  });

  it('does not report names shadowed by parameters and local bindings', () => {
    const file = parseTs(
      src(
        "import { helper } from './helper';",
        'function format() {}',
        'type Item = { id: string };',
        'export function shadowed(helper: () => void) {',
        '  helper();',
        '  const format = 1;',
        '  try { run(format); } catch (Item) { Item(); }',
        '  for (const helper of []) helper();',
        '  { const format = 2; format; }',
        '  var late = 1;',
        '  function inner() { return late; }',
        '  return inner();',
        '}',
        'export function generic<Item>(x: Item): Item { return x; }',
        'export function used() { helper(); format(); const x: Item = { id: "1" }; return x; }',
      ),
    );
    expect(describeRefs(file)).toEqual([
      'used -> ./helper#helper [calls]',
      'used -> format [calls]',
      'used -> Item [uses-type]',
    ]);
  });

  it('keeps value and type meanings apart', () => {
    const file = parseTs(
      src(
        'const User = schema();',
        'type User = Infer<typeof User>;',
        'export function f(Session: number) { const u: User = User.parse(Session); return u; }',
      ),
    );
    expect(describeRefs(file)).toEqual(['User~2 -> User [uses-type]', 'f -> User~2 [uses-type]', 'f -> User [references]']);
  });
});
