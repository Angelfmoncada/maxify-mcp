import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { fixtureDir, repoRoot } from '../../src/bench/fixture.js';

const root = fixtureDir(repoRoot());

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir).sort()) {
    if (name === 'node_modules' || name === '.git') continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const files = walk(root);
const rel = (file: string): string => path.relative(root, file).split(path.sep).join('/');
const read = (name: string): string => readFileSync(path.join(root, ...name.split('/')), 'utf8');
const codeFiles = files.filter((file) => /\.(ts|tsx)$/.test(file));

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
}

describe('taskboard fixture size and layout', () => {
  it('has about 40-60 files and about 3-4k lines', () => {
    const lines = files.reduce((total, file) => total + readFileSync(file, 'utf8').split('\n').length - 1, 0);
    expect(files.length).toBeGreaterThanOrEqual(40);
    expect(files.length).toBeLessThanOrEqual(65);
    expect(lines).toBeGreaterThanOrEqual(3000);
    expect(lines).toBeLessThanOrEqual(4300);
  });

  it('contains the required modules, decoys and docs', () => {
    const names = files.map(rel);
    for (const required of [
      'README.md',
      'docs/architecture.md',
      'package.json',
      'tsconfig.json',
      'src/shared/index.ts',
      'src/shared/types.ts',
      'src/shared/validation.ts',
      'src/shared/errors.ts',
      'src/server/auth/token.ts',
      'src/server/auth/middleware.ts',
      'src/server/tasks/repository.ts',
      'src/server/tasks/service.ts',
      'src/server/tasks/routes.ts',
      'src/server/http/router.ts',
      'src/server/app.ts',
      'src/server/config.ts',
      'src/server/plugins/loader.ts',
      'src/server/lib/legacy-csv.cjs',
      'src/web/App.tsx',
      'src/web/components/TaskList.tsx',
      'src/web/components/TaskItem.tsx',
      'src/web/components/TaskForm.tsx',
      'src/web/hooks/useTasks.ts',
      'src/web/hooks/useAuth.tsx',
      'src/web/api/client.ts',
      'src/web/utils/tokenize.ts',
      'src/legacy/auth/session-token.ts',
    ]) {
      expect(names, required).toContain(required);
    }
    expect(names.filter((name) => name.startsWith('test/') && name.endsWith('.test.ts')).length).toBeGreaterThanOrEqual(10);
  });

  it('uses LF line endings only', () => {
    for (const file of files) expect(readFileSync(file, 'utf8').includes('\r'), rel(file)).toBe(false);
  });
});

describe('taskboard fixture code', () => {
  it('parses without syntax errors', () => {
    for (const file of codeFiles) {
      const output = ts.transpileModule(readFileSync(file, 'utf8'), {
        reportDiagnostics: true,
        fileName: file,
        compilerOptions: { jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext, verbatimModuleSyntax: true },
      });
      expect(output.diagnostics?.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')), rel(file)).toEqual([]);
    }
  });

  it('keeps the Node-run code erasable: no enums, namespaces or parameter properties', () => {
    const runnable = codeFiles.filter((file) => /^(src\/(shared|server|legacy)|test)\//.test(rel(file)));
    expect(runnable.length).toBeGreaterThan(30);
    for (const file of runnable) {
      const offenders: string[] = [];
      const visit = (node: ts.Node): void => {
        if (ts.isEnumDeclaration(node)) offenders.push('enum');
        if (ts.isModuleDeclaration(node) && !node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword)) offenders.push('namespace');
        if (ts.isParameter(node) && ts.isConstructorDeclaration(node.parent) && (ts.getCombinedModifierFlags(node) & ts.ModifierFlags.ParameterPropertyModifier) !== 0) {
          offenders.push('parameter property');
        }
        if (ts.isImportEqualsDeclaration(node) || (ts.isExportAssignment(node) && node.isExportEquals === true)) offenders.push('import = / export =');
        ts.forEachChild(node, visit);
      };
      visit(parse(file));
      expect(offenders, rel(file)).toEqual([]);
    }
  });

  it('ends every relative import of the tested path with an explicit .ts extension', () => {
    const runnable = codeFiles.filter((file) => /^(src\/(shared|server)|test)\//.test(rel(file)));
    for (const file of runnable) {
      const specifiers: string[] = [];
      const visit = (node: ts.Node): void => {
        if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier !== undefined && ts.isStringLiteral(node.moduleSpecifier)) {
          specifiers.push(node.moduleSpecifier.text);
        }
        if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
          const argument = node.arguments[0];
          if (argument !== undefined && ts.isTemplateExpression(argument)) specifiers.push(argument.templateSpans.map((span) => span.literal.text).join(''));
          if (argument !== undefined && ts.isStringLiteral(argument)) specifiers.push(argument.text);
        }
        ts.forEachChild(node, visit);
      };
      visit(parse(file));
      for (const specifier of specifiers.filter((text) => text.startsWith('.'))) {
        expect(specifier, `${rel(file)} imports ${specifier}`).toMatch(/\.ts$/);
      }
    }
  });

  it('uses the @shared alias at runtime only in web files', () => {
    for (const file of codeFiles) {
      const text = readFileSync(file, 'utf8');
      const runtimeAlias = [...text.matchAll(/^import\s+(?!type\b)[^;]*from\s+'@shared\//gm)];
      if (!rel(file).startsWith('src/web/')) expect(runtimeAlias.length, rel(file)).toBe(0);
    }
    expect(codeFiles.filter((file) => rel(file).startsWith('src/web/')).some((file) => readFileSync(file, 'utf8').includes("'@shared/"))).toBe(true);
    expect(JSON.parse(read('tsconfig.json')).compilerOptions.paths['@shared/*']).toEqual(['./src/shared/*']);
  });

  it('contains the intended uncertainty, decoys and CommonJS module', () => {
    expect(read('src/server/plugins/loader.ts')).toMatch(/await import\(`\.\/builtin\/\$\{name\}\.ts`\)/);
    expect(read('src/server/lib/legacy-csv.cjs')).toContain('module.exports');
    expect(read('src/web/utils/tokenize.ts')).toContain('export function tokenize');
    const legacy = read('src/legacy/auth/session-token.ts');
    expect(legacy).toContain('export function verifyToken');
    expect(legacy).toContain('export function isTokenExpired');
  });

  it('never imports the legacy folder', () => {
    for (const file of codeFiles.filter((entry) => !rel(entry).startsWith('src/legacy/'))) {
      expect(readFileSync(file, 'utf8'), rel(file)).not.toMatch(/from\s+['"][^'"]*legacy\//);
    }
  });

  it('re-exports the shared modules with export * from the barrel', () => {
    expect(read('src/shared/index.ts').match(/^export \* from /gm)?.length).toBeGreaterThanOrEqual(4);
  });
});

describe('taskboard fixture tests', () => {
  it('declares an npm test script with an explicit glob', () => {
    expect(JSON.parse(read('package.json')).scripts.test).toBe('node --test test/*.test.ts');
  });

  it('passes with node --test (Node type stripping, no build)', () => {
    const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', 'test/*.test.ts'], { cwd: root, encoding: 'utf8', timeout: 120_000 });
    const summary = (name: string): number => Number(new RegExp(`^# ${name} (\\d+)$`, 'm').exec(result.stdout)?.[1] ?? Number.NaN);
    expect(result.status, result.stdout.slice(-2000) + result.stderr.slice(-1000)).toBe(0);
    expect(summary('fail')).toBe(0);
    expect(summary('pass')).toBeGreaterThanOrEqual(100);
  }, 120_000);
});
