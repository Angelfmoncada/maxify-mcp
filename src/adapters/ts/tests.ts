/**
 * Test structure: describe/suite/context -> 'suite', it/test/specify -> 'test',
 * including modifier chains (.only, .skip, .todo, .concurrent, Playwright's
 * test.describe.serial, ...) and factories (.each(table)(title, fn),
 * .for, .runIf, .skipIf). Only literal titles are recognized.
 */
import ts from 'typescript';
import { truncate } from '../shared.js';
import type { SymbolDraft } from './drafts.js';
import { docInfo } from './jsdoc.js';
import type { BuildContext } from './members.js';
import { isStaticString, MAX_WALK_DEPTH, type TsSource } from './source.js';

const SUITE_BASES = new Map<string, readonly string[]>([
  ['describe', []],
  ['suite', []],
  ['context', []],
  ['xdescribe', ['skip']],
  ['fdescribe', ['only']],
]);
const TEST_BASES = new Map<string, readonly string[]>([
  ['it', []],
  ['test', []],
  ['specify', []],
  ['xit', ['skip']],
  ['xtest', ['skip']],
  ['fit', ['only']],
]);
const MODIFIERS = new Set([
  'only',
  'skip',
  'todo',
  'concurrent',
  'sequential',
  'shuffle',
  'fails',
  'failing',
  'fail',
  'serial',
  'parallel',
  'fixme',
]);
const FACTORIES = new Set(['each', 'for', 'runIf', 'skipIf']);
const SIGNATURE_LIMIT = 200;

export interface TestCall {
  readonly kind: 'suite' | 'test';
  readonly title: string;
  /** Title literal as written, quotes included. */
  readonly titleText: string;
  /** Callee label, e.g. 'describe', 'it.only', 'test.each(…)'. */
  readonly label: string;
  readonly flags: readonly string[];
}

function chainOf(expr: ts.Expression): string[] | null {
  if (ts.isIdentifier(expr)) return [expr.text];
  if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.name)) {
    const head = chainOf(expr.expression);
    return head ? [...head, expr.name.text] : null;
  }
  return null;
}

function classify(chain: readonly string[]): { kind: 'suite' | 'test'; flags: string[] } | null {
  const [base = '', ...rest] = chain;
  const suiteFlags = SUITE_BASES.get(base);
  const testFlags = TEST_BASES.get(base);
  let kind: 'suite' | 'test';
  let modifiers = rest;
  if (suiteFlags) {
    kind = 'suite';
  } else if (testFlags) {
    kind = rest[0] === 'describe' ? 'suite' : 'test';
    if (kind === 'suite') modifiers = rest.slice(1);
  } else {
    return null;
  }
  if (!modifiers.every((m) => MODIFIERS.has(m))) return null;
  return { kind, flags: [...(suiteFlags ?? testFlags ?? []), ...modifiers] };
}

function calleeChain(callee: ts.LeftHandSideExpression): { chain: string[]; factory: string | null } | null {
  if (ts.isCallExpression(callee) || ts.isTaggedTemplateExpression(callee)) {
    const inner = chainOf(ts.isCallExpression(callee) ? callee.expression : callee.tag);
    const factory = inner?.[inner.length - 1];
    if (!inner || inner.length < 2 || factory === undefined || !FACTORIES.has(factory)) return null;
    return { chain: inner.slice(0, -1), factory };
  }
  const chain = chainOf(callee);
  return chain ? { chain, factory: null } : null;
}

/** Describe a call as a test/suite registration, or null when it is not one. */
export function testCallOf(src: TsSource, call: ts.CallExpression): TestCall | null {
  const title = call.arguments[0];
  if (!isStaticString(title)) return null;
  const callee = calleeChain(call.expression);
  if (!callee) return null;
  const classified = classify(callee.chain);
  if (!classified) return null;
  const base = callee.chain.join('.');
  return {
    kind: classified.kind,
    title: title.text,
    titleText: title.getText(src.sf),
    label: callee.factory ? `${base}.${callee.factory}(…)` : base,
    flags: callee.factory ? [...classified.flags, callee.factory] : classified.flags,
  };
}

/** Add a test/suite symbol and every test registered inside its callbacks. */
export function addTestCall(ctx: BuildContext, call: ts.CallExpression, test: TestCall, parent: SymbolDraft | null): void {
  const host = ts.isExpressionStatement(call.parent) ? call.parent : call;
  const info = docInfo(ctx.src, host);
  const draft = ctx.sink.add({
    name: test.title,
    qual: parent ? `${parent.qual} > ${test.title}` : test.title,
    kind: test.kind,
    start: info.start,
    end: host.end,
    signature: truncate(`${test.label}(${test.titleText})`, SIGNATURE_LIMIT),
    doc: info.doc,
    flags: info.deprecated ? [...test.flags, 'deprecated'] : test.flags,
    parent,
    nodes: [call],
  });
  for (const arg of call.arguments.slice(1)) findTests(ctx, arg, draft);
}

/** Find test registrations anywhere below `node` (nested callbacks, loops, helpers). */
export function findTests(ctx: BuildContext, node: ts.Node, parent: SymbolDraft | null, depth = 0): void {
  if (ts.isCallExpression(node)) {
    const test = testCallOf(ctx.src, node);
    if (test) {
      addTestCall(ctx, node, test, parent);
      return;
    }
  }
  if (depth >= MAX_WALK_DEPTH) return;
  ts.forEachChild(node, (child) => {
    findTests(ctx, child, parent, depth + 1);
  });
}

/** The test call a top-level statement consists of, if any. */
export function statementTestCall(src: TsSource, stmt: ts.Statement): { call: ts.CallExpression; test: TestCall } | null {
  if (!ts.isExpressionStatement(stmt) || !ts.isCallExpression(stmt.expression)) return null;
  const test = testCallOf(src, stmt.expression);
  return test ? { call: stmt.expression, test } : null;
}
