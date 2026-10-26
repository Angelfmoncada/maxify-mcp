/**
 * Module-level statements that are not declarations, imports, exports or
 * test registrations (route registration, side effects, setup code) are
 * grouped into 'block' symbols of at most 60 lines, split at statement
 * boundaries. Each block is named after a short label of its first statement.
 */
import ts from 'typescript';
import { collapseWhitespace, truncate } from '../shared.js';
import { docInfo, spanStartOf } from './jsdoc.js';
import { isFunctionNode } from './kinds.js';
import type { BuildContext } from './members.js';
import { normalizeCode } from './normalize.js';
import { isStaticString, lastLine, unwrapExpression, type TsSource } from './source.js';

const MAX_BLOCK_LINES = 60;
const NAME_LIMIT = 60;
const LABEL_LIMIT = 100;
const SIGNATURE_STATEMENTS = 20;
const LABEL_DEPTH = 8;

const BLOCK_KINDS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.ExpressionStatement,
  ts.SyntaxKind.IfStatement,
  ts.SyntaxKind.ForStatement,
  ts.SyntaxKind.ForInStatement,
  ts.SyntaxKind.ForOfStatement,
  ts.SyntaxKind.WhileStatement,
  ts.SyntaxKind.DoStatement,
  ts.SyntaxKind.TryStatement,
  ts.SyntaxKind.SwitchStatement,
  ts.SyntaxKind.LabeledStatement,
  ts.SyntaxKind.Block,
  ts.SyntaxKind.ThrowStatement,
  ts.SyntaxKind.ReturnStatement,
  ts.SyntaxKind.WithStatement,
  ts.SyntaxKind.DebuggerStatement,
  ts.SyntaxKind.BreakStatement,
  ts.SyntaxKind.ContinueStatement,
]);

/** Statements that can be part of a block. */
export function isBlockStatement(stmt: ts.Statement): boolean {
  return BLOCK_KINDS.has(stmt.kind);
}

/** Empty statements and string directives ('use client') neither start nor break a block. */
export function isTransparentStatement(stmt: ts.Statement): boolean {
  return ts.isEmptyStatement(stmt) || (ts.isExpressionStatement(stmt) && ts.isStringLiteral(stmt.expression));
}

function isAssignmentOperator(kind: ts.SyntaxKind): boolean {
  return kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;
}

function preview(src: TsSource, node: ts.Node, max: number): string {
  const start = node.getStart(src.sf);
  return truncate(normalizeCode(src.text.slice(start, Math.min(node.end, start + max * 4))), max);
}

function literalLabel(src: TsSource, node: ts.Node): string | null {
  if (isStaticString(node) || ts.isNumericLiteral(node) || ts.isIdentifier(node)) return node.getText(src.sf);
  const kind = node.kind;
  if (kind === ts.SyntaxKind.TrueKeyword || kind === ts.SyntaxKind.FalseKeyword || kind === ts.SyntaxKind.NullKeyword) {
    return node.getText(src.sf);
  }
  return null;
}

function argumentLabel(src: TsSource, args: ts.NodeArray<ts.Expression> | undefined): string {
  const first = args?.[0];
  return first ? (literalLabel(src, first) ?? '…') : '';
}

function exprLabel(src: TsSource, expr: ts.Expression, depth = 0): string {
  if (depth > LABEL_DEPTH) return '…';
  const next = (e: ts.Expression): string => exprLabel(src, e, depth + 1);
  if (ts.isIdentifier(expr) || expr.kind === ts.SyntaxKind.ThisKeyword || expr.kind === ts.SyntaxKind.SuperKeyword) {
    return expr.getText(src.sf);
  }
  if (ts.isPropertyAccessExpression(expr)) return `${next(expr.expression)}${expr.questionDotToken ? '?.' : '.'}${expr.name.text}`;
  if (ts.isElementAccessExpression(expr)) {
    return `${next(expr.expression)}[${literalLabel(src, expr.argumentExpression) ?? '…'}]`;
  }
  if (ts.isCallExpression(expr)) return `${next(expr.expression)}(${argumentLabel(src, expr.arguments)})`;
  if (ts.isNewExpression(expr)) return `new ${next(expr.expression)}(${argumentLabel(src, expr.arguments)})`;
  if (ts.isAwaitExpression(expr)) return `await ${next(expr.expression)}`;
  if (ts.isParenthesizedExpression(expr)) return isFunctionNode(unwrapExpression(expr)) ? '(…)' : `(${next(expr.expression)})`;
  if (ts.isBinaryExpression(expr) && isAssignmentOperator(expr.operatorToken.kind)) {
    return `${next(expr.left)} ${expr.operatorToken.getText(src.sf)} ${literalLabel(src, expr.right) ?? '…'}`;
  }
  if (ts.isNonNullExpression(expr) || ts.isAsExpression(expr) || ts.isSatisfiesExpression(expr)) return next(expr.expression);
  return preview(src, expr, NAME_LIMIT);
}

/** Short human label of a statement, e.g. `app.get('/tasks')` or `if (process.env.DEBUG)`. */
export function statementLabel(src: TsSource, stmt: ts.Statement): string {
  const clip = (e: ts.Expression): string => preview(src, e, 50);
  if (ts.isExpressionStatement(stmt)) return exprLabel(src, stmt.expression);
  if (ts.isIfStatement(stmt)) return `if (${clip(stmt.expression)})`;
  if (ts.isForStatement(stmt) || ts.isForInStatement(stmt) || ts.isForOfStatement(stmt)) {
    const start = stmt.getStart(src.sf);
    return normalizeCode(src.text.slice(start, Math.min(stmt.statement.getStart(src.sf), start + 400)));
  }
  if (ts.isWhileStatement(stmt)) return `while (${clip(stmt.expression)})`;
  if (ts.isDoStatement(stmt)) return `do … while (${clip(stmt.expression)})`;
  if (ts.isTryStatement(stmt)) return 'try';
  if (ts.isSwitchStatement(stmt)) return `switch (${clip(stmt.expression)})`;
  if (ts.isLabeledStatement(stmt)) return `${stmt.label.text}:`;
  if (ts.isBlock(stmt)) return '{…}';
  if (ts.isThrowStatement(stmt)) return `throw ${exprLabel(src, stmt.expression)}`;
  return collapseWhitespace(preview(src, stmt, NAME_LIMIT));
}

function blockSignature(labels: readonly string[]): string {
  const shown = labels.slice(0, SIGNATURE_STATEMENTS).map((label) => truncate(label, LABEL_LIMIT));
  const omitted = labels.length - shown.length;
  return [...shown, ...(omitted > 0 ? [`/* … ${omitted} more statements */`] : [])].join('\n');
}

function addBlock(ctx: BuildContext, chunk: readonly ts.Statement[]): void {
  const first = chunk[0];
  const last = chunk[chunk.length - 1];
  if (!first || !last) return;
  const info = docInfo(ctx.src, first);
  const labels = chunk.map((stmt) => statementLabel(ctx.src, stmt));
  ctx.sink.add({
    name: truncate(labels[0] ?? 'block', NAME_LIMIT),
    qual: `block@L${ctx.src.line(info.start)}`,
    kind: 'block',
    start: info.start,
    end: last.end,
    signature: blockSignature(labels),
    doc: info.doc,
    parent: null,
    nodes: chunk,
  });
}

/** Split a run of consecutive block statements into blocks of at most 60 lines. */
export function addBlocks(ctx: BuildContext, run: readonly ts.Statement[]): void {
  // Local accumulator: minified files can put thousands of statements on one line.
  let chunk: ts.Statement[] = [];
  let chunkStartLine = 0;
  for (const stmt of run) {
    const start = spanStartOf(ctx.src, stmt);
    const endLine = lastLine(ctx.src, start, stmt.end);
    if (chunk.length > 0 && endLine - chunkStartLine + 1 > MAX_BLOCK_LINES) {
      addBlock(ctx, chunk);
      chunk = [];
    }
    if (chunk.length === 0) chunkStartLine = ctx.src.line(start);
    chunk.push(stmt);
  }
  if (chunk.length > 0) addBlock(ctx, chunk);
}
