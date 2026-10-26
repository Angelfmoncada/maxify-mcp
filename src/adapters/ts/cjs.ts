/**
 * CommonJS export heuristics: `module.exports = X`, `module.exports.foo = X`,
 * `exports.foo = X` (also `exports['foo'] = X` and chains `a = b = X`).
 * Symbols are created for function/class/object/other values; identifier
 * values are matched to local declarations by the export pass.
 */
import ts from 'typescript';
import type { SymbolKind } from '../../core/types.js';
import type { SymbolDraft } from './drafts.js';
import { docInfo, type DocInfo } from './jsdoc.js';
import { containsJsx, directFunction, functionKind } from './kinds.js';
import { addClass, addObjectMembers, bodyFlags, type BuildContext } from './members.js';
import { memberSignature, valueSignature } from './signatures.js';
import { isStaticString, propertyNameText, unwrapExpression } from './source.js';

export type CjsTarget = { readonly kind: 'module' } | { readonly kind: 'named'; readonly name: string };

export interface CjsAssignment {
  readonly stmt: ts.ExpressionStatement;
  /** Assignment targets from outermost to innermost (`exports.a = exports.b = X`). */
  readonly targets: readonly CjsTarget[];
  /** Normalized text of the outermost target, e.g. 'module.exports' or 'exports.foo'. */
  readonly targetText: string;
  readonly value: ts.Expression;
}

export function isModuleExports(node: ts.Node): boolean {
  return (
    ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'module' &&
    node.name.text === 'exports'
  );
}

/** `module.exports` or the free `exports` identifier. */
export function isExportsObject(node: ts.Node): boolean {
  return isModuleExports(node) || (ts.isIdentifier(node) && node.text === 'exports');
}

function cjsTarget(left: ts.Expression): CjsTarget | null {
  if (isModuleExports(left)) return { kind: 'module' };
  if (ts.isPropertyAccessExpression(left) && ts.isIdentifier(left.name) && isExportsObject(left.expression)) {
    return { kind: 'named', name: left.name.text };
  }
  if (ts.isElementAccessExpression(left) && isStaticString(left.argumentExpression) && isExportsObject(left.expression)) {
    return { kind: 'named', name: left.argumentExpression.text };
  }
  return null;
}

/** Parse a top-level statement as a CommonJS export assignment. */
export function cjsAssignment(stmt: ts.Statement, sf: ts.SourceFile): CjsAssignment | null {
  if (!ts.isExpressionStatement(stmt)) return null;
  const targets: CjsTarget[] = [];
  let first: ts.Expression | null = null;
  let expr: ts.Expression = stmt.expression;
  while (ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    const target = cjsTarget(expr.left);
    if (!target) break;
    targets.push(target);
    first ??= expr.left;
    expr = expr.right;
  }
  if (!first) return null;
  return { stmt, targets, targetText: first.getText(sf).replace(/\s+/g, ''), value: expr };
}

/** `void 0` / `undefined` placeholders emitted by compilers are not exports. */
export function isPlaceholderValue(value: ts.Expression): boolean {
  const inner = unwrapExpression(value);
  return ts.isVoidExpression(inner) || (ts.isIdentifier(inner) && inner.text === 'undefined');
}

function isReferenceMember(member: ts.ObjectLiteralElementLike): boolean {
  return (
    ts.isShorthandPropertyAssignment(member) ||
    (ts.isPropertyAssignment(member) && ts.isIdentifier(unwrapExpression(member.initializer)))
  );
}

function memberFunction(member: ts.ObjectLiteralElementLike): ts.FunctionLikeDeclaration | null {
  if (ts.isMethodDeclaration(member) || ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member)) {
    return member;
  }
  return ts.isPropertyAssignment(member) ? directFunction(member.initializer) : null;
}

function isFunctionMember(member: ts.ObjectLiteralElementLike): boolean {
  return memberFunction(member) !== null;
}

interface ValueContext {
  readonly name: string;
  readonly exportName: string;
  readonly prefix: string;
  readonly info: DocInfo;
  readonly stmt: ts.ExpressionStatement;
}

function addFunctionMembersAsExports(ctx: BuildContext, obj: ts.ObjectLiteralExpression): void {
  const { src, sink } = ctx;
  for (const member of obj.properties) {
    const fn = memberFunction(member);
    if (!fn || !member.name) continue;
    const name = propertyNameText(src, member.name);
    const info = docInfo(src, member);
    sink.add({
      name,
      kind: functionKind(name, containsJsx(src, fn)),
      start: info.start,
      end: member.end,
      signature: memberSignature(src, member) ?? '',
      doc: info.doc,
      flags: ['commonjs', ...bodyFlags(src, fn), ...(info.deprecated ? ['deprecated'] : [])],
      exportNames: [name],
      parent: null,
      nodes: [member],
    });
  }
}

function addValueSymbol(ctx: BuildContext, vc: ValueContext, kind: SymbolKind, extra: Partial<SymbolDraft> = {}): SymbolDraft {
  return ctx.sink.add({
    name: vc.name,
    kind,
    start: vc.info.start,
    end: vc.stmt.end,
    signature: extra.signature ?? '',
    doc: vc.info.doc,
    flags: extra.flags ?? ['commonjs'],
    exportNames: [vc.exportName],
    parent: null,
    nodes: [vc.stmt],
    container: extra.container ?? null,
  });
}

function addAssignedValue(ctx: BuildContext, vc: ValueContext, value: ts.Expression, moduleTarget: boolean): void {
  const { src } = ctx;
  if (ts.isClassExpression(value)) {
    addClass(ctx, value, {
      name: moduleTarget ? (value.name?.text ?? vc.name) : vc.name,
      parent: null,
      info: vc.info,
      end: vc.stmt.end,
      nodes: [vc.stmt],
      exportNames: [vc.exportName],
      flags: ['commonjs'],
      signaturePrefix: vc.prefix,
      binds: false,
    });
    return;
  }
  const fn = directFunction(value);
  if (fn) {
    const name = moduleTarget && ts.isFunctionExpression(fn) && fn.name ? fn.name.text : vc.name;
    const signature = valueSignature(src, vc.prefix, value);
    const kind = functionKind(name, containsJsx(src, fn));
    addValueSymbol(ctx, { ...vc, name }, kind, { signature, flags: ['commonjs', ...bodyFlags(src, fn)] });
    return;
  }
  const signature = valueSignature(src, vc.prefix, value);
  if (ts.isObjectLiteralExpression(value) && moduleTarget) {
    addFunctionMembersAsExports(ctx, value);
    const hasData = value.properties.some((m) => !isReferenceMember(m) && !isFunctionMember(m));
    if (hasData) addValueSymbol(ctx, vc, 'variable', { signature });
    return;
  }
  const container = ts.isObjectLiteralExpression(value) ? value : null;
  const owner = addValueSymbol(ctx, vc, 'variable', { signature, container });
  if (container) addObjectMembers(ctx, container, owner);
}

/** Create symbols for a CommonJS export assignment (identifier values are left to the export pass). */
export function addCjsSymbols(ctx: BuildContext, assignment: CjsAssignment): void {
  const value = unwrapExpression(assignment.value);
  const target = assignment.targets[0];
  if (!target || ts.isIdentifier(value) || isPlaceholderValue(value)) return;
  const moduleTarget = target.kind === 'module';
  const name = target.kind === 'named' ? target.name : 'default';
  const vc: ValueContext = {
    name,
    exportName: name,
    prefix: `${assignment.targetText} = `,
    info: docInfo(ctx.src, assignment.stmt),
    stmt: assignment.stmt,
  };
  addAssignedValue(ctx, vc, value, moduleTarget);
}
