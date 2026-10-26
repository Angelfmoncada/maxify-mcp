/**
 * Declaration pass over the top-level statements: declarations, default
 * exports, CommonJS exports, test registrations and module-level blocks.
 */
import ts from 'typescript';
import { addBlocks, isBlockStatement, isTransparentStatement } from './blocks.js';
import { addCjsSymbols, cjsAssignment } from './cjs.js';
import { addDeclaration } from './declarations.js';
import { createDraftSink, type SymbolDraft } from './drafts.js';
import { docInfo } from './jsdoc.js';
import { containsJsx, directFunction, functionHeadEnd, functionKind, wrappedFunction } from './kinds.js';
import { addClass, addObjectMembers, bodyFlags, type BuildContext } from './members.js';
import { isImportCall, isRequireCall, literalSpecifier } from './module-calls.js';
import { codeBetween, valueSignature } from './signatures.js';
import { unwrapExpression, type TsSource } from './source.js';
import { addTestCall, findTests, statementTestCall } from './tests.js';

/** `export default <expr>` / `export = <expr>` with a non-identifier value. */
function addExportAssignment(ctx: BuildContext, node: ts.ExportAssignment): void {
  const { src, sink } = ctx;
  const value = unwrapExpression(node.expression);
  if (ts.isIdentifier(value)) return;
  const prefix = node.isExportEquals ? 'export = ' : 'export default ';
  const flags = node.isExportEquals ? ['export-equals'] : [];
  const info = docInfo(src, node);
  if (ts.isClassExpression(value)) {
    const name = value.name?.text ?? 'default';
    addClass(ctx, value, { name, parent: null, info, end: node.end, nodes: [node], exportNames: ['default'], flags, signaturePrefix: prefix, binds: false });
    return;
  }
  const direct = directFunction(value);
  const fn = direct ?? wrappedFunction(value);
  const base = { start: info.start, end: node.end, doc: info.doc, exportNames: ['default'], parent: null, nodes: [node] };
  if (fn && (direct !== null || containsJsx(src, fn))) {
    const name = direct && ts.isFunctionExpression(direct) && direct.name ? direct.name.text : 'default';
    sink.add({
      ...base,
      name,
      kind: functionKind(name, containsJsx(src, fn)),
      signature: `${prefix}${codeBetween(src, value.getStart(src.sf), functionHeadEnd(src, fn))}`,
      flags: [...flags, ...bodyFlags(src, fn), ...(info.deprecated ? ['deprecated'] : [])],
    });
    return;
  }
  const container = ts.isObjectLiteralExpression(value) ? value : null;
  const owner = sink.add({
    ...base,
    name: 'default',
    kind: 'variable',
    signature: valueSignature(src, prefix, value),
    flags: [...flags, ...(info.deprecated ? ['deprecated'] : [])],
    container,
  });
  if (container) addObjectMembers(ctx, container, owner);
}

/** `require('m');` / `await import('m');` statements are imports, not module-level blocks. */
function isModuleLoadStatement(stmt: ts.Statement): boolean {
  if (!ts.isExpressionStatement(stmt)) return false;
  let expr = unwrapExpression(stmt.expression);
  if (ts.isAwaitExpression(expr)) expr = unwrapExpression(expr.expression);
  return (isRequireCall(expr) || isImportCall(expr)) && literalSpecifier(expr) !== null;
}

function addStatement(ctx: BuildContext, stmt: ts.Statement): void {
  if (ts.isExportAssignment(stmt)) addExportAssignment(ctx, stmt);
  else addDeclaration(ctx, stmt, null);
}

/** Collect symbol drafts for a source file (unordered; see finalize.ts). */
export function collectSymbols(src: TsSource): readonly SymbolDraft[] {
  const sink = createDraftSink();
  const ctx: BuildContext = { src, sink };
  // Local accumulator for the current run of block statements.
  let run: ts.Statement[] = [];
  const flush = (): void => {
    if (run.length > 0) addBlocks(ctx, run);
    run = [];
  };
  for (const stmt of src.sf.statements) {
    if (isTransparentStatement(stmt)) continue;
    const test = statementTestCall(src, stmt);
    const cjs = test ? null : cjsAssignment(stmt, src.sf);
    if (!test && !cjs && isBlockStatement(stmt) && !isModuleLoadStatement(stmt)) {
      run.push(stmt);
      findTests(ctx, stmt, null);
      continue;
    }
    flush();
    if (test) addTestCall(ctx, test.call, test.test, null);
    else if (cjs) addCjsSymbols(ctx, cjs);
    else addStatement(ctx, stmt);
  }
  flush();
  return sink.drafts;
}
