import { describe, expect, it } from 'vitest';
import { importOf, parseTs, qualNames, src, sym } from './helpers.js';

describe('typescript adapter: ES exports', () => {
  it('marks export modifiers', () => {
    const file = parseTs(
      src(
        'export function a() {}',
        'export class B {}',
        'export interface C {}',
        'export type D = 1;',
        'export enum E { X }',
        'export const f = 1, g = 2;',
        'export namespace H {}',
        'function hidden() {}',
      ),
    );
    for (const name of ['a', 'B', 'C', 'D', 'E', 'f', 'g', 'H']) {
      expect(sym(file, name).exported).toBe(true);
      expect(sym(file, name).exportNames).toEqual([name]);
    }
    expect(sym(file, 'hidden').exported).toBe(false);
    expect(sym(file, 'hidden').exportNames).toEqual([]);
  });

  it('handles export default declarations, anonymous or named', () => {
    const named = parseTs('export default function main() {}');
    expect(sym(named, 'main').exportNames).toEqual(['default']);
    expect(sym(named, 'main').flags).toContain('default-export');
    const anonymousClass = parseTs('export default class { run() {} }');
    expect(qualNames(anonymousClass)).toEqual(['default', 'default.run']);
    expect(sym(anonymousClass, 'default').kind).toBe('class');
  });

  it('creates a default symbol for exported expressions', () => {
    const file = parseTs(
      src('export default defineConfig({', '  plugins: [react()],', '  build: { outDir: "dist" },', '});'),
      'vite.config.ts',
    );
    const def = sym(file, 'default');
    expect(def.kind).toBe('variable');
    expect(def.exportNames).toEqual(['default']);
    expect(def.span).toEqual({ startLine: 1, endLine: 4 });
    expect(def.signature).toBe('export default defineConfig({ plugins: [react()], build: { outDir: "dist" } })');
  });

  it('collects methods of default-exported object literals', () => {
    const file = parseTs('export default { name: "x", data() { return {}; }, mounted: () => {} };');
    expect(qualNames(file)).toEqual(['default', 'default.data', 'default.mounted']);
  });

  it('maps export lists back to local declarations', () => {
    const file = parseTs(
      src(
        'function a() {}',
        'const b = 1;',
        'interface T {}',
        'function c() {}',
        'export { a, b as renamed, c as default };',
        'export type { T };',
        'export { a as again };',
      ),
    );
    expect(sym(file, 'a').exportNames).toEqual(['a', 'again']);
    expect(sym(file, 'b').exportNames).toEqual(['renamed']);
    expect(sym(file, 'T').exportNames).toEqual(['T']);
    expect(sym(file, 'c').exportNames).toEqual(['default']);
    expect(sym(file, 'c').flags).toEqual(['default-export']);
  });

  it('marks every declaration merged under an exported name', () => {
    const file = parseTs(src('const User = z.object({});', 'type User = z.infer<typeof User>;', 'export { User };'));
    expect(file.symbols.filter((s) => s.name === 'User').map((s) => s.exported)).toEqual([true, true]);
  });

  it('maps `export default name` and `export = name`', () => {
    const def = parseTs(src('class Store {}', 'export default Store;'));
    expect(sym(def, 'Store').exportNames).toEqual(['default']);
    const equals = parseTs(src('function legacy() {}', 'export = legacy;'));
    expect(sym(equals, 'legacy').exportNames).toEqual(['default']);
    expect(sym(equals, 'legacy').flags).toEqual(['default-export', 'export-equals']);
  });

  it('turns exports of imported bindings into re-export records', () => {
    const file = parseTs(
      src(
        "import Foo from './Foo';",
        "import { bar as baz, type Qux } from './bar';",
        "import * as ns from './ns';",
        'export { baz, Qux, ns as namespace };',
        'export default Foo;',
      ),
    );
    expect(file.symbols).toEqual([]);
    expect(file.imports.map((i) => [i.kind, i.spec, i.line])).toEqual([
      ['import', './Foo', 1],
      ['import', './bar', 2],
      ['import', './ns', 3],
      ['reexport', './bar', 4],
      ['reexport', './ns', 4],
      ['reexport', './Foo', 5],
    ]);
    expect(file.imports[3]?.bindings).toEqual([
      { imported: 'bar', local: 'baz', typeOnly: false },
      { imported: 'Qux', local: 'Qux', typeOnly: true },
    ]);
    expect(file.imports[4]?.bindings).toEqual([{ imported: '*', local: 'namespace', typeOnly: false }]);
    expect(file.imports[5]?.bindings).toEqual([{ imported: 'default', local: 'default', typeOnly: false }]);
  });
});

describe('typescript adapter: CommonJS exports', () => {
  it('marks identifiers assigned to module.exports and exports.*', () => {
    const file = parseTs(
      src(
        'function handler() {}',
        'function helper() {}',
        'const VALUE = 1;',
        'module.exports = handler;',
        'exports.helper = helper;',
        'module.exports.value = VALUE;',
      ),
      'lib/index.js',
    );
    expect(sym(file, 'handler').exportNames).toEqual(['default']);
    expect(sym(file, 'handler').flags).toEqual(['default-export', 'commonjs']);
    expect(sym(file, 'helper').exportNames).toEqual(['helper']);
    expect(sym(file, 'helper').flags).toEqual(['commonjs']);
    expect(sym(file, 'VALUE').exportNames).toEqual(['value']);
  });

  it('creates symbols for function, class and value assignments', () => {
    const file = parseTs(
      src(
        'module.exports = function main(req, res) {};',
        'exports.parse = (text) => text;',
        'module.exports.Parser = class { run() {} };',
        "exports['VERSION'] = '1.0';",
        'exports.a = exports.b = void 0;',
      ),
      'lib/index.cjs',
    );
    expect(qualNames(file)).toEqual(['main', 'parse', 'Parser', 'Parser.run', 'VERSION']);
    expect(sym(file, 'main').exportNames).toEqual(['default']);
    expect(sym(file, 'main').signature).toBe('module.exports = function main(req, res)');
    expect(sym(file, 'parse').kind).toBe('function');
    expect(sym(file, 'parse').signature).toBe('exports.parse = (text) =>');
    expect(sym(file, 'Parser').kind).toBe('class');
    expect(sym(file, 'VERSION').kind).toBe('variable');
    expect(sym(file, 'VERSION').signature).toBe("exports['VERSION'] = '1.0'");
    for (const s of file.symbols.filter((x) => x.parent === null)) expect(s.flags).toContain('commonjs');
  });

  it('handles module.exports object literals', () => {
    const file = parseTs(
      src(
        'function a() {}',
        'function localB() {}',
        'module.exports = {',
        '  a,',
        '  b: localB,',
        '  run() { return a(); },',
        '  stop: () => {},',
        '};',
      ),
      'lib/api.js',
    );
    expect(qualNames(file)).toEqual(['a', 'localB', 'run', 'stop']);
    expect(sym(file, 'a').exportNames).toEqual(['a']);
    expect(sym(file, 'localB').exportNames).toEqual(['b']);
    expect(sym(file, 'run').exportNames).toEqual(['run']);
    expect(sym(file, 'run').flags).toEqual(['commonjs']);
  });

  it('adds a default symbol when the exported object carries data', () => {
    const file = parseTs(src('module.exports = {', "  entry: './src/index.js',", '  mode: "production",', '};'), 'webpack.config.js');
    expect(qualNames(file)).toEqual(['default']);
    expect(sym(file, 'default').span).toEqual({ startLine: 1, endLine: 4 });
    expect(sym(file, 'default').signature).toBe('module.exports = { entry: \'./src/index.js\', mode: "production" }');
  });

  it('re-exports required bindings', () => {
    const file = parseTs(src("const { join } = require('path');", 'module.exports = { join };'), 'lib/x.js');
    expect(importOf(file, 'path', 'reexport').bindings).toEqual([{ imported: 'join', local: 'join', typeOnly: false }]);
  });
});
