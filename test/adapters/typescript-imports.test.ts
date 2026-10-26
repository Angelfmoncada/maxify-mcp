import { describe, expect, it } from 'vitest';
import { importOf, parseTs, src } from './helpers.js';

describe('typescript adapter: ES imports', () => {
  const file = parseTs(
    src(
      "import React from 'react';", // 1
      "import { useState, useEffect as effect } from 'react';", // 2
      "import * as path from 'node:path';", // 3
      "import Def, { named } from './mixed';", // 4
      "import Def2, * as all from './mixed2';", // 5
      "import type { Props } from './props';", // 6
      "import type Ctx from './ctx';", // 7
      "import { type A, b } from './inline';", // 8
      "import './polyfill';", // 9
      "import { 'quoted-name' as quoted } from './quoted';", // 10
      "import fs = require('fs');", // 11
      "import type cfg = require('./cfg');", // 12
    ),
  );

  it('records default, named and namespace bindings', () => {
    expect(file.imports[0]).toEqual({
      spec: 'react',
      kind: 'import',
      bindings: [{ imported: 'default', local: 'React', typeOnly: false }],
      line: 1,
    });
    expect(file.imports[1]?.bindings).toEqual([
      { imported: 'useState', local: 'useState', typeOnly: false },
      { imported: 'useEffect', local: 'effect', typeOnly: false },
    ]);
    expect(importOf(file, 'node:path').bindings).toEqual([{ imported: '*', local: 'path', typeOnly: false }]);
    expect(importOf(file, './mixed').bindings.map((b) => b.imported)).toEqual(['default', 'named']);
    expect(importOf(file, './mixed2').bindings.map((b) => b.imported)).toEqual(['default', '*']);
    expect(importOf(file, './quoted').bindings).toEqual([{ imported: 'quoted-name', local: 'quoted', typeOnly: false }]);
  });

  it('marks type-only imports', () => {
    expect(importOf(file, './props')).toMatchObject({ kind: 'import-type', bindings: [{ imported: 'Props', local: 'Props', typeOnly: true }] });
    expect(importOf(file, './ctx')).toMatchObject({ kind: 'import-type', bindings: [{ imported: 'default', local: 'Ctx', typeOnly: true }] });
    expect(importOf(file, './inline')).toMatchObject({
      kind: 'import',
      bindings: [
        { imported: 'A', local: 'A', typeOnly: true },
        { imported: 'b', local: 'b', typeOnly: false },
      ],
    });
  });

  it('records side-effect imports and import-equals', () => {
    expect(importOf(file, './polyfill')).toEqual({ spec: './polyfill', kind: 'side-effect', bindings: [], line: 9 });
    expect(importOf(file, 'fs')).toEqual({
      spec: 'fs',
      kind: 'require',
      bindings: [{ imported: '*', local: 'fs', typeOnly: false }],
      line: 11,
    });
    expect(importOf(file, './cfg').bindings).toEqual([{ imported: '*', local: 'cfg', typeOnly: true }]);
  });

  it('creates no symbols for import statements', () => {
    expect(file.symbols).toEqual([]);
  });
});

describe('typescript adapter: re-exports', () => {
  it('records named, namespace and star re-exports', () => {
    const file = parseTs(
      src(
        "export { a as b, c } from './x';",
        "export * from './all';",
        "export * as ns from './ns';",
        "export type { T } from './types';",
        "export type * from './types-all';",
        "export { default } from './Comp';",
        "export { default as Button } from './Button';",
      ),
    );
    expect(file.imports).toEqual([
      {
        spec: './x',
        kind: 'reexport',
        bindings: [
          { imported: 'a', local: 'b', typeOnly: false },
          { imported: 'c', local: 'c', typeOnly: false },
        ],
        line: 1,
      },
      { spec: './all', kind: 'reexport-all', bindings: [{ imported: '*', local: '', typeOnly: false }], line: 2 },
      { spec: './ns', kind: 'reexport', bindings: [{ imported: '*', local: 'ns', typeOnly: false }], line: 3 },
      { spec: './types', kind: 'reexport', bindings: [{ imported: 'T', local: 'T', typeOnly: true }], line: 4 },
      { spec: './types-all', kind: 'reexport-all', bindings: [{ imported: '*', local: '', typeOnly: true }], line: 5 },
      { spec: './Comp', kind: 'reexport', bindings: [{ imported: 'default', local: 'default', typeOnly: false }], line: 6 },
      { spec: './Button', kind: 'reexport', bindings: [{ imported: 'default', local: 'Button', typeOnly: false }], line: 7 },
    ]);
  });
});

describe('typescript adapter: require and dynamic import', () => {
  const file = parseTs(
    src(
      "const express = require('express');", // 1
      "const { join, resolve: res, ...rest } = require('path');", // 2
      "const lodash = require('lodash').default;", // 3
      "require('dotenv/config');", // 4
      'async function load() {', // 5
      "  const mod = await import('./lazy');", // 6
      "  const { a, default: Main } = await import('./named');", // 7
      "  import('./fire-and-forget').then((m) => m.run());", // 8
      "  const local = require('./local');", // 9
      '  return [mod, a, Main, local];', // 10
      '}', // 11
      "const tpl = require(`./template`);", // 12
    ),
    'src/loader.js',
  );

  it('records require() with bindings from the declarator', () => {
    expect(importOf(file, 'express')).toEqual({
      spec: 'express',
      kind: 'require',
      bindings: [{ imported: '*', local: 'express', typeOnly: false }],
      line: 1,
    });
    expect(importOf(file, 'path').bindings).toEqual([
      { imported: 'join', local: 'join', typeOnly: false },
      { imported: 'resolve', local: 'res', typeOnly: false },
      { imported: '*', local: 'rest', typeOnly: false },
    ]);
    expect(importOf(file, 'lodash').bindings).toEqual([{ imported: 'default', local: 'lodash', typeOnly: false }]);
    expect(importOf(file, 'dotenv/config')).toEqual({ spec: 'dotenv/config', kind: 'require', bindings: [], line: 4 });
    expect(importOf(file, './template').bindings).toEqual([{ imported: '*', local: 'tpl', typeOnly: false }]);
  });

  it('records dynamic imports with bindings when awaited into a declarator', () => {
    expect(importOf(file, './lazy')).toEqual({
      spec: './lazy',
      kind: 'dynamic-import',
      bindings: [{ imported: '*', local: 'mod', typeOnly: false }],
      line: 6,
    });
    expect(importOf(file, './named').bindings).toEqual([
      { imported: 'a', local: 'a', typeOnly: false },
      { imported: 'default', local: 'Main', typeOnly: false },
    ]);
    expect(importOf(file, './fire-and-forget')).toMatchObject({ kind: 'dynamic-import', bindings: [], line: 8 });
    expect(importOf(file, './local')).toMatchObject({ kind: 'require', line: 9 });
  });

  it('does not create symbols for module-scope require bindings', () => {
    expect(file.symbols.map((s) => s.qualName)).toEqual(['load']);
  });

  it('keeps imports in document order', () => {
    expect(file.imports.map((i) => i.line)).toEqual([1, 2, 3, 4, 6, 7, 8, 9, 12]);
  });
});

describe('typescript adapter: import types', () => {
  it('records import() type references', () => {
    const file = parseTs(src("type Cfg = import('./config').Config;", "let mod: typeof import('./mod');"));
    expect(file.imports).toEqual([
      { spec: './config', kind: 'import-type', bindings: [{ imported: 'Config', local: '', typeOnly: true }], line: 1 },
      { spec: './mod', kind: 'import-type', bindings: [{ imported: '*', local: '', typeOnly: true }], line: 2 },
    ]);
  });

  it('reads JSDoc import types and @import tags in JavaScript files', () => {
    const file = parseTs(
      src(
        "/** @import { Options } from './options' */",
        '',
        "/** @param {import('./user').User} user */",
        'export function greet(user) { return user.name; }',
      ),
      'src/greet.js',
    );
    expect(file.imports).toEqual([
      { spec: './options', kind: 'import-type', bindings: [{ imported: 'Options', local: 'Options', typeOnly: true }], line: 1 },
      { spec: './user', kind: 'import-type', bindings: [{ imported: 'User', local: '', typeOnly: true }], line: 3 },
    ]);
  });
});
