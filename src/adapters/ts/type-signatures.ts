/**
 * Signatures of interfaces, type aliases and enums: the verbatim declaration
 * when it spans at most 40 lines, otherwise a header plus as many members as
 * fit (one normalized line each) and an explicit "N more" marker line.
 */
import ts from 'typescript';
import { truncate } from '../shared.js';
import { normalizeCode } from './normalize.js';
import { headStart, lastLine, type TsSource } from './source.js';

const MAX_LINES = 40;
const MEMBER_LINE_LIMIT = 200;

type TypeDeclaration = ts.InterfaceDeclaration | ts.TypeAliasDeclaration | ts.EnumDeclaration;

interface Outline {
  /** Header text up to and including the opening token ('{' or '='). */
  readonly headerEnd: number;
  readonly members: readonly string[];
  /** Closing line ('}' for braces, '' for unions). */
  readonly closer: string;
  readonly unit: string;
}

function memberLine(src: TsSource, member: ts.Node, suffix = ''): string {
  const text = normalizeCode(src.text.slice(member.getStart(src.sf), member.end));
  return `  ${truncate(`${text}${suffix}`, MEMBER_LINE_LIMIT)}`;
}

function outlineOf(src: TsSource, node: TypeDeclaration): Outline | null {
  if (ts.isInterfaceDeclaration(node)) {
    return { headerEnd: node.members.pos, members: node.members.map((m) => memberLine(src, m)), closer: '}', unit: 'members' };
  }
  if (ts.isEnumDeclaration(node)) {
    return { headerEnd: node.members.pos, members: node.members.map((m) => memberLine(src, m, ',')), closer: '}', unit: 'members' };
  }
  const type = node.type;
  if (ts.isTypeLiteralNode(type)) {
    return { headerEnd: type.members.pos, members: type.members.map((m) => memberLine(src, m)), closer: '}', unit: 'members' };
  }
  if (ts.isUnionTypeNode(type) || ts.isIntersectionTypeNode(type)) {
    const op = ts.isUnionTypeNode(type) ? '|' : '&';
    const members = type.types.map((t) => `  ${op} ${truncate(normalizeCode(src.text.slice(t.getStart(src.sf), t.end)), MEMBER_LINE_LIMIT)}`);
    return { headerEnd: type.pos, members, closer: '', unit: 'members' };
  }
  return null;
}

function linesFallback(text: string): string {
  const lines = text.split('\n');
  const kept = lines.slice(0, MAX_LINES - 1);
  return [...kept, `/* … ${lines.length - kept.length} more lines */`].join('\n');
}

/** Signature of an interface, type alias or enum (see module doc). */
export function typeDeclarationSignature(src: TsSource, node: TypeDeclaration): string {
  const start = headStart(src, node);
  const verbatim = src.text.slice(start, node.end).replace(/\r\n/g, '\n');
  if (lastLine(src, start, node.end) - src.line(start) + 1 <= MAX_LINES) return verbatim;
  const outline = outlineOf(src, node);
  if (!outline) return linesFallback(verbatim);
  const header = normalizeCode(src.text.slice(start, Math.max(start, outline.headerEnd)));
  const closer = outline.closer === '' ? [] : [outline.closer];
  const room = MAX_LINES - 1 - closer.length;
  if (outline.members.length <= room) return [header, ...outline.members, ...closer].join('\n');
  const shown = outline.members.slice(0, room - 1);
  const marker = `  /* … ${outline.members.length - shown.length} more ${outline.unit} */`;
  return [header, ...shown, marker, ...closer].join('\n');
}
