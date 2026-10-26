/**
 * JSDoc helpers: leading doc comments of declarations, their rendered text,
 * the @deprecated marker and the span start including the doc comment.
 * File-level comments (@file, @license, ...) are never attributed to the
 * declaration that happens to follow them.
 */
import ts from 'typescript';
import { truncate } from '../shared.js';
import type { TsSource } from './source.js';

const FILE_LEVEL_TAGS = new Set(['file', 'fileoverview', 'overview', 'license', 'copyright', 'module', 'packagedocumentation']);
const TYPE_TAGS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.JSDocTypeTag,
  ts.SyntaxKind.JSDocSatisfiesTag,
  ts.SyntaxKind.JSDocThisTag,
  ts.SyntaxKind.JSDocEnumTag,
]);
const DOC_LIMIT = 400;

/** Raw JSDoc nodes the parser attached to `node` (internal property, read defensively). */
export function rawJsDocs(node: ts.Node): readonly ts.JSDoc[] {
  const docs: unknown = (node as unknown as { jsDoc?: unknown }).jsDoc;
  return Array.isArray(docs) ? (docs as ts.JSDoc[]) : [];
}

function isFileLevel(doc: ts.JSDoc): boolean {
  return (doc.tags ?? []).some((tag) => FILE_LEVEL_TAGS.has(tag.tagName.text.toLowerCase()));
}

/** Doc comments that belong to the declaration itself. */
export function jsDocsOf(node: ts.Node): readonly ts.JSDoc[] {
  return rawJsDocs(node).filter((doc) => !isFileLevel(doc));
}

function commentText(comment: string | ts.NodeArray<ts.JSDocComment> | undefined): string {
  return (ts.getTextOfJSDocComment(comment) ?? '').trim();
}

function entityText(name: ts.EntityName): string {
  return ts.isIdentifier(name) ? name.text : `${entityText(name.left)}.${name.right.text}`;
}

function renderTag(src: TsSource, tag: ts.JSDocTag): string {
  const head = `@${tag.tagName.text}`;
  const comment = commentText(tag.comment);
  const suffix = comment === '' ? '' : ` ${comment}`;
  if (ts.isJSDocParameterTag(tag) || ts.isJSDocPropertyTag(tag)) {
    const name = entityText(tag.name);
    return `${head} ${tag.isBracketed ? `[${name}]` : name}${suffix}`;
  }
  if (ts.isJSDocTemplateTag(tag)) {
    return `${head} ${tag.typeParameters.map((p) => p.name.text).join(', ')}${suffix}`;
  }
  if (TYPE_TAGS.has(tag.kind)) {
    const typed = tag as ts.JSDocTypeTag;
    const type = typed.typeExpression ? ` ${src.text.slice(typed.typeExpression.pos, typed.typeExpression.end).trim()}` : '';
    return `${head}${type}${suffix}`;
  }
  return `${head}${suffix}`;
}

/** Text of the closest doc comment: description, then one line per tag; at most 400 characters. */
export function docText(src: TsSource, docs: readonly ts.JSDoc[]): string {
  const doc = docs[docs.length - 1];
  if (!doc) return '';
  const parts: string[] = [];
  const description = commentText(doc.comment);
  if (description !== '') parts.push(description);
  for (const tag of doc.tags ?? []) parts.push(renderTag(src, tag));
  return truncate(parts.join('\n').trim(), DOC_LIMIT);
}

export function isDeprecated(docs: readonly ts.JSDoc[]): boolean {
  return docs.some((doc) => (doc.tags ?? []).some((tag) => tag.kind === ts.SyntaxKind.JSDocDeprecatedTag));
}

/** Span start of a declaration: its first own JSDoc comment, else its first token (decorators included). */
export function spanStartOf(src: TsSource, node: ts.Node): number {
  const start = node.getStart(src.sf);
  const first = jsDocsOf(node)[0];
  return first ? Math.min(first.pos, start) : start;
}

/** Doc text, deprecated flag and span start in one call. */
export interface DocInfo {
  readonly doc: string;
  readonly deprecated: boolean;
  readonly start: number;
}

export function docInfo(src: TsSource, node: ts.Node): DocInfo {
  const docs = jsDocsOf(node);
  return { doc: docText(src, docs), deprecated: isDeprecated(docs), start: spanStartOf(src, node) };
}
