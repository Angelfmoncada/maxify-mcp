/**
 * Symbol-kind heuristics that are decidable from syntax alone:
 * React components (PascalCase + JSX, or typed FC), hooks (use*), and
 * function-valued initializers (possibly wrapped in memo()/forwardRef()).
 */
import ts from 'typescript';
import type { SymbolKind } from '../../core/types.js';
import { someNode, unwrapExpression, type TsSource } from './source.js';

const HOOK_NAME = /^use[A-Z0-9]/;
const PASCAL_NAME = /^[A-Z][A-Za-z0-9]*$/;
const COMPONENT_TYPES = new Set([
  'FC',
  'FunctionComponent',
  'VFC',
  'VoidFunctionComponent',
  'ComponentType',
  'React.FC',
  'React.FunctionComponent',
  'React.VFC',
  'React.VoidFunctionComponent',
  'React.ComponentType',
]);
const WRAPPER_DEPTH = 3;

export type FunctionNode = ts.ArrowFunction | ts.FunctionExpression;

export function isHookName(name: string): boolean {
  return HOOK_NAME.test(name);
}

export function isPascalName(name: string): boolean {
  return PASCAL_NAME.test(name);
}

const JSX_KINDS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.JsxElement,
  ts.SyntaxKind.JsxSelfClosingElement,
  ts.SyntaxKind.JsxFragment,
]);

function isJsxNode(node: ts.Node): boolean {
  return JSX_KINDS.has(node.kind);
}

/** Memoized per syntax node (entries die with the tree); the same body is asked about repeatedly. */
const jsxCache = new WeakMap<ts.Node, boolean>();

/** True when the subtree contains a JSX element or fragment. */
export function containsJsx(src: TsSource, node: ts.Node | undefined): boolean {
  if (!src.mayHaveJsx || node === undefined) return false;
  const cached = jsxCache.get(node);
  if (cached !== undefined) return cached;
  const found = someNode(node, isJsxNode);
  jsxCache.set(node, found);
  return found;
}

function entityText(name: ts.EntityName): string {
  return ts.isIdentifier(name) ? name.text : `${entityText(name.left)}.${name.right.text}`;
}

/** `const X: FC<P> = ...` and friends. */
export function typedAsComponent(type: ts.TypeNode | undefined): boolean {
  return type !== undefined && ts.isTypeReferenceNode(type) && COMPONENT_TYPES.has(entityText(type.typeName));
}

/** Kind for a function-like symbol named `name`. */
export function functionKind(name: string, hasJsx: boolean, componentTyped = false): SymbolKind {
  if (isHookName(name)) return 'hook';
  if (componentTyped) return 'component';
  if (hasJsx && (PASCAL_NAME.test(name) || name === 'default')) return 'component';
  return 'function';
}

export function isFunctionNode(node: ts.Node): node is FunctionNode {
  return ts.isArrowFunction(node) || ts.isFunctionExpression(node);
}

/** The arrow/function expression an initializer evaluates to, ignoring parentheses and casts. */
export function directFunction(init: ts.Expression | undefined): FunctionNode | null {
  if (!init) return null;
  const inner = unwrapExpression(init);
  return isFunctionNode(inner) ? inner : null;
}

/**
 * A function passed to a wrapper call such as memo(() => ...), forwardRef(...)
 * or observer(...), searched through nested calls up to a small depth.
 */
export function wrappedFunction(init: ts.Expression | undefined, depth = 0): FunctionNode | null {
  if (!init || depth > WRAPPER_DEPTH) return null;
  const inner = unwrapExpression(init);
  if (!ts.isCallExpression(inner)) return null;
  for (const arg of inner.arguments) {
    const fn = directFunction(arg) ?? wrappedFunction(arg, depth + 1);
    if (fn) return fn;
  }
  return null;
}

export function isAsync(node: ts.Node): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) ?? false);
}

/** Character offset where a function's head ends: after '=>' for arrows, else at the body. */
export function functionHeadEnd(src: TsSource, fn: ts.FunctionLikeDeclaration): number {
  if (ts.isArrowFunction(fn)) return fn.equalsGreaterThanToken.end;
  return fn.body ? fn.body.getStart(src.sf) : fn.end;
}
