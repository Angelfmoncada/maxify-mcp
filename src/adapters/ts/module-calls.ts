/**
 * Recognition of module-loading calls: require('m'), import('m') and the
 * declarators that bind their results.
 */
import ts from 'typescript';
import { isStaticString, unwrapExpression } from './source.js';

export function isRequireCall(node: ts.Node): node is ts.CallExpression {
  return (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'require' &&
    node.arguments.length >= 1
  );
}

export function isImportCall(node: ts.Node): node is ts.CallExpression {
  return ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword;
}

/** The literal module specifier of a require()/import() call, or null when it is computed. */
export function literalSpecifier(call: ts.CallExpression): string | null {
  const arg = call.arguments[0];
  return isStaticString(arg) ? arg.text : null;
}

export interface BoundModuleCall {
  readonly call: ts.CallExpression;
  /** `x` in `require('m').x` / `(await import('m')).x`; null when the whole module is bound. */
  readonly member: string | null;
}

/**
 * The require()/import() call whose result an initializer binds:
 * `require('m')`, `require('m').x`, `await import('m')`, `(await import('m')).x`.
 */
export function boundModuleCall(init: ts.Expression | undefined): BoundModuleCall | null {
  if (!init) return null;
  let expr = unwrapExpression(init);
  let member: string | null = null;
  if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.name)) {
    member = expr.name.text;
    expr = unwrapExpression(expr.expression);
  }
  if (ts.isAwaitExpression(expr)) {
    const inner = unwrapExpression(expr.expression);
    return isImportCall(inner) && literalSpecifier(inner) !== null ? { call: inner, member } : null;
  }
  return isRequireCall(expr) && literalSpecifier(expr) !== null ? { call: expr, member } : null;
}
