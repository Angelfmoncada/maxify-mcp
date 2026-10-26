/**
 * Signatures: derived, body-free views of declarations, normalized to a
 * single line per declaration/member (see normalize.ts). Class signatures
 * are a header line plus one line per member.
 */
import ts from 'typescript';
import { truncate } from '../shared.js';
import { directFunction, functionHeadEnd, type FunctionNode } from './kinds.js';
import { normalizeCode, normalizeMember } from './normalize.js';
import { headStart, someNode, type TsSource } from './source.js';

const SHORT_INITIALIZER = 80;
const VALUE_PREVIEW = 80;
const CLASS_MEMBER_LIMIT = 60;

type FunctionLikeHead =
  | ts.FunctionDeclaration
  | ts.MethodDeclaration
  | ts.ConstructorDeclaration
  | ts.GetAccessorDeclaration
  | ts.SetAccessorDeclaration;

export function codeBetween(src: TsSource, start: number, end: number): string {
  return normalizeCode(src.text.slice(start, Math.max(start, end)));
}

/** `export async function f(a: A): R` - head of a function/method without its body. */
export function functionSignature(src: TsSource, node: FunctionLikeHead): string {
  const end = node.body ? node.body.getStart(src.sf) : node.end;
  return normalizeMember(src.text.slice(headStart(src, node), end));
}

/** `export const` / `let` / `declare const` - the part of a variable statement before its first name. */
export function statementPrefix(src: TsSource, stmt: ts.VariableStatement): string {
  const first = stmt.declarationList.declarations[0];
  const end = first ? first.getStart(src.sf) : stmt.declarationList.end;
  return codeBetween(src, headStart(src, stmt), end);
}

/** `export const name = async (a: A): R =>` for a function-valued declarator. */
export function functionVariableSignature(
  src: TsSource,
  prefix: string,
  decl: ts.VariableDeclaration,
  fn: FunctionNode,
): string {
  return `${prefix} ${codeBetween(src, decl.getStart(src.sf), functionHeadEnd(src, fn))}`;
}

function isFunctionOrClass(node: ts.Node): boolean {
  return ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isClassExpression(node);
}

/** Initializer text when it is short and contains no function or class body; else null. */
export function shortInitializer(src: TsSource, init: ts.Expression): string | null {
  const start = init.getStart(src.sf);
  if (init.end - start > SHORT_INITIALIZER * 3 || someNode(init, isFunctionOrClass)) return null;
  const text = codeBetween(src, start, init.end);
  return text.length <= SHORT_INITIALIZER ? text : null;
}

/** `export const name: Type`, `const name = <short initializer>` or `const name`. */
export function variableSignature(src: TsSource, prefix: string, decl: ts.VariableDeclaration): string {
  const name = `${codeBetween(src, decl.name.getStart(src.sf), decl.name.end)}${decl.exclamationToken ? '!' : ''}`;
  if (decl.type) return `${prefix} ${name}: ${codeBetween(src, decl.type.getStart(src.sf), decl.type.end)}`;
  const short = decl.initializer ? shortInitializer(src, decl.initializer) : null;
  return short === null ? `${prefix} ${name}` : `${prefix} ${name} = ${short}`;
}

function propertySignature(src: TsSource, member: ts.PropertyDeclaration): string {
  const fn = directFunction(member.initializer);
  const start = headStart(src, member);
  if (fn) return codeBetween(src, start, functionHeadEnd(src, fn));
  const end = Math.max(
    member.name.end,
    member.questionToken?.end ?? 0,
    member.exclamationToken?.end ?? 0,
    member.type?.end ?? 0,
  );
  return normalizeMember(src.text.slice(start, end));
}

/** One-line signature of a class or object-literal member; null when it has none. */
export function memberSignature(src: TsSource, member: ts.ClassElement | ts.ObjectLiteralElementLike): string | null {
  if (
    ts.isMethodDeclaration(member) ||
    ts.isConstructorDeclaration(member) ||
    ts.isGetAccessorDeclaration(member) ||
    ts.isSetAccessorDeclaration(member)
  ) {
    return functionSignature(src, member);
  }
  if (ts.isPropertyDeclaration(member)) return propertySignature(src, member);
  if (ts.isIndexSignatureDeclaration(member)) return normalizeMember(src.text.slice(headStart(src, member), member.end));
  if (ts.isPropertyAssignment(member)) {
    const fn = directFunction(member.initializer);
    return fn ? codeBetween(src, member.getStart(src.sf), functionHeadEnd(src, fn)) : null;
  }
  return null;
}

/**
 * Header line, one line per member signature (2-space indent), closing brace.
 * `memberLines` may carry precomputed memberSignature() results (same order as node.members).
 */
export function classSignature(
  src: TsSource,
  node: ts.ClassLikeDeclaration,
  prefix = '',
  memberLines: ReadonlyArray<string | null> = node.members.map((member) => memberSignature(src, member)),
): string {
  const start = headStart(src, node);
  const header = codeBetween(src, start, Math.max(start, node.members.pos));
  const members = memberLines.filter((line): line is string => line !== null && line !== '');
  const shown = members.slice(0, CLASS_MEMBER_LIMIT).map((line) => `  ${line}`);
  const omitted = members.length - shown.length;
  const more = omitted > 0 ? [`  /* … ${omitted} more members */`] : [];
  const head = header.endsWith('{') ? header : `${header} {`;
  return [`${prefix}${head}`, ...shown, ...more, '}'].join('\n');
}

/** `export namespace A.B` / `declare module 'x'` without the body. */
export function namespaceSignature(src: TsSource, node: ts.ModuleDeclaration): string {
  let body = node.body;
  while (body && ts.isModuleDeclaration(body)) body = body.body;
  const end = body ? body.getStart(src.sf) : node.end;
  return normalizeMember(src.text.slice(headStart(src, node), end));
}

/** `<prefix>(a) =>` for function values, else `<prefix><value preview>` (at most 80 chars of value). */
export function valueSignature(src: TsSource, prefix: string, expr: ts.Expression): string {
  const fn = directFunction(expr);
  if (fn) return `${prefix}${codeBetween(src, fn.getStart(src.sf), functionHeadEnd(src, fn))}`;
  const start = expr.getStart(src.sf);
  const text = codeBetween(src, start, Math.min(expr.end, start + VALUE_PREVIEW * 5));
  return `${prefix}${truncate(text, VALUE_PREVIEW)}`;
}
