/**
 * Parsed TypeScript/JavaScript source plus position helpers shared by the
 * TypeScript adapter modules. Syntax only: no Program, no type checker.
 */
import ts from 'typescript';
import { collapseWhitespace, createLineIndex, truncate } from '../shared.js';

export interface TsSource {
  readonly sf: ts.SourceFile;
  readonly text: string;
  readonly isJs: boolean;
  /** False for .ts/.mts/.cts files, which cannot contain JSX. */
  readonly mayHaveJsx: boolean;
  /** 1-based line of a character offset. */
  readonly line: (pos: number) => number;
}

export function createTsSource(relPath: string, text: string, kind: ts.ScriptKind, isJs: boolean): TsSource {
  const sf = ts.createSourceFile(relPath, text, ts.ScriptTarget.Latest, true, kind);
  return {
    sf,
    text,
    isJs,
    mayHaveJsx: sf.languageVariant === ts.LanguageVariant.JSX,
    line: createLineIndex(text),
  };
}

/** Last line of the half-open range [start, end). */
export function lastLine(src: TsSource, start: number, end: number): number {
  return src.line(Math.max(start, end - 1));
}

/** Skip whitespace and comments starting at `pos`. */
export function skipTrivia(text: string, pos: number): number {
  let i = pos;
  while (i < text.length) {
    const c = text.charCodeAt(i);
    if (c === 32 || c === 9 || c === 10 || c === 13 || c === 11 || c === 12 || c === 0xa0 || c === 0xfeff) {
      i++;
      continue;
    }
    if (c === 47 && text.charCodeAt(i + 1) === 47) {
      const nl = text.indexOf('\n', i);
      i = nl === -1 ? text.length : nl + 1;
      continue;
    }
    if (c === 47 && text.charCodeAt(i + 1) === 42) {
      const close = text.indexOf('*/', i + 2);
      i = close === -1 ? text.length : close + 2;
      continue;
    }
    break;
  }
  return i;
}

/** Start of a declaration's head: first non-decorator modifier or keyword (decorators are skipped). */
export function headStart(src: TsSource, node: ts.Node): number {
  const modifiers = ts.canHaveModifiers(node) ? node.modifiers : undefined;
  if (!modifiers || modifiers.length === 0) return node.getStart(src.sf);
  const plain = modifiers.find((m) => m.kind !== ts.SyntaxKind.Decorator);
  if (plain) return plain.getStart(src.sf);
  const last = modifiers[modifiers.length - 1];
  return last ? skipTrivia(src.text, last.end) : node.getStart(src.sf);
}

export function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  if (!ts.canHaveModifiers(node)) return false;
  return ts.getModifiers(node)?.some((m) => m.kind === kind) ?? false;
}

const WRAPPER_KINDS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.ParenthesizedExpression,
  ts.SyntaxKind.AsExpression,
  ts.SyntaxKind.SatisfiesExpression,
  ts.SyntaxKind.NonNullExpression,
  ts.SyntaxKind.TypeAssertionExpression,
]);

type WrapperExpression =
  | ts.ParenthesizedExpression
  | ts.AsExpression
  | ts.SatisfiesExpression
  | ts.NonNullExpression
  | ts.TypeAssertion;

/** Strip parentheses, `as`, `satisfies`, `!` and `<T>` assertions around an expression. */
export function unwrapExpression(expr: ts.Expression): ts.Expression {
  let current = expr;
  while (WRAPPER_KINDS.has(current.kind)) current = (current as WrapperExpression).expression;
  return current;
}

/** Name of a property-like name node: identifiers, private names, literals, `[computed]`. */
export function propertyNameText(src: TsSource, name: ts.PropertyName | ts.ModuleExportName): string {
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) return name.text;
  if (ts.isStringLiteral(name) || ts.isNumericLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) {
    return name.text;
  }
  if (ts.isComputedPropertyName(name)) return `[${collapseWhitespace(name.expression.getText(src.sf))}]`;
  return collapseWhitespace(name.getText(src.sf));
}

/** Verbatim excerpt of a node on one line (whitespace runs collapsed), at most `max` characters. */
export function excerpt(src: TsSource, node: ts.Node, max = 160): string {
  const start = node.getStart(src.sf);
  const raw = src.text.slice(start, Math.min(node.end, start + max * 4));
  return truncate(collapseWhitespace(raw), max);
}

/**
 * Maximum syntax depth the recursive walkers descend into. Deeper subtrees
 * (pathological generated code) are skipped instead of overflowing the stack.
 */
export const MAX_WALK_DEPTH = 1000;

const { forEachChild } = ts;

/** True when `predicate` holds for `root` or any descendant (depth-limited). */
export function someNode(root: ts.Node, predicate: (node: ts.Node) => boolean): boolean {
  let depth = 0;
  const visit = (node: ts.Node): boolean => {
    if (predicate(node)) return true;
    if (depth >= MAX_WALK_DEPTH) return false;
    depth++;
    const found = forEachChild(node, visit) === true;
    depth--;
    return found;
  };
  return visit(root);
}

/** True for string literals and no-substitution template literals. */
export function isStaticString(node: ts.Node | undefined): node is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral {
  return node !== undefined && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node));
}
