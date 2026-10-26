/**
 * Line-level Markdown structure: fenced code / front matter regions, ATX and
 * setext headings, first paragraphs and relative link targets.
 */
import { collapseWhitespace } from './shared.js';

export interface Heading {
  readonly level: number;
  readonly text: string;
  /** 1-based first line of the heading (the text line for setext headings). */
  readonly line: number;
  /** 1-based first line after the heading markup. */
  readonly bodyLine: number;
}

export interface MarkdownStructure {
  /** codeLines[i] is true when line i+1 is fenced code, a fence line or front matter. */
  readonly codeLines: readonly boolean[];
  readonly headings: readonly Heading[];
  /** headingLines[i] is true when line i+1 belongs to a heading. */
  readonly headingLines: readonly boolean[];
}

const ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const SETEXT = /^ {0,3}(=+|-{2,})[ \t]*$/;
const THEMATIC_BREAK = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const NOT_PARAGRAPH = /^(?: {4}|\t| {0,3}(?:>|\||<|[-*+][ \t]|\d+[.)][ \t]))/;

function isBlank(line: string | undefined): boolean {
  return line === undefined || line.trim() === '';
}

/** Strip inline markup from heading text: links -> text, HTML tags, backticks, bold markers. */
export function cleanInline(text: string): string {
  return collapseWhitespace(
    text
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/<[^>]+>/g, '')
      .replace(/`+/g, '')
      .replace(/\*\*|__/g, ''),
  );
}

function frontMatterEnd(lines: readonly string[]): number {
  const marker = lines[0]?.trim();
  if (marker !== '---' && marker !== '+++') return -1;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]?.trim();
    if (line === marker || (marker === '---' && line === '...')) return i;
  }
  return -1;
}

function fenceClose(lines: readonly string[], from: number, fence: string): number {
  const char = fence[0] ?? '`';
  for (let i = from; i < lines.length; i++) {
    const match = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(lines[i] ?? '');
    if (match?.[1] && match[1][0] === char && match[1].length >= fence.length) return i;
  }
  return lines.length - 1;
}

function isParagraphLine(line: string | undefined): boolean {
  if (line === undefined || isBlank(line)) return false;
  return !ATX.test(line) && !NOT_PARAGRAPH.test(line) && !SETEXT.test(line) && !THEMATIC_BREAK.test(line) && !FENCE_OPEN.test(line);
}

/**
 * A setext paragraph must start a block: at the top of the file or after a
 * blank line, heading, code region or thematic break (not as the
 * continuation of a list item, quote or table).
 */
function opensParagraph(lines: readonly string[], code: readonly boolean[], headings: readonly boolean[], start: number): boolean {
  if (start === 0) return true;
  const before = lines[start - 1];
  return isBlank(before) || code[start - 1] === true || headings[start - 1] === true || THEMATIC_BREAK.test(before ?? '');
}

/** Mark code regions (front matter and fenced blocks). */
function codeRegions(lines: readonly string[]): boolean[] {
  const code = new Array<boolean>(lines.length).fill(false);
  const front = frontMatterEnd(lines);
  for (let i = 0; i <= front; i++) code[i] = true;
  for (let i = front + 1; i < lines.length; i++) {
    const open = FENCE_OPEN.exec(lines[i] ?? '');
    const fence = open?.[1];
    if (!fence || (fence.startsWith('`') && (open[2] ?? '').includes('`'))) continue;
    const close = fenceClose(lines, i + 1, fence);
    for (let j = i; j <= close; j++) code[j] = true;
    i = close;
  }
  return code;
}

/** Scan headings outside code regions. */
export function scanMarkdown(lines: readonly string[]): MarkdownStructure {
  const codeLines = codeRegions(lines);
  const headingLines = new Array<boolean>(lines.length).fill(false);
  const headings: Heading[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (codeLines[i]) continue;
    const line = lines[i] ?? '';
    const atx = ATX.exec(line);
    if (atx?.[1]) {
      headings.push({ level: atx[1].length, text: cleanInline(atx[2] ?? ''), line: i + 1, bodyLine: i + 2 });
      headingLines[i] = true;
      continue;
    }
    const setext = SETEXT.exec(line);
    if (!setext?.[1] || i === 0 || codeLines[i - 1] || headingLines[i - 1] || !isParagraphLine(lines[i - 1])) continue;
    let start = i - 1;
    while (start > 0 && !codeLines[start - 1] && !headingLines[start - 1] && isParagraphLine(lines[start - 1])) start--;
    if (!opensParagraph(lines, codeLines, headingLines, start)) continue;
    const text = cleanInline(lines.slice(start, i).join(' '));
    headings.push({ level: setext[1].startsWith('=') ? 1 : 2, text, line: start + 1, bodyLine: i + 2 });
    for (let j = start; j <= i; j++) headingLines[j] = true;
  }
  return { codeLines, headings: headings.filter((h) => h.text !== ''), headingLines };
}

/** First paragraph between `fromLine` and `toLine` (1-based, inclusive), skipping code and comments. */
export function firstParagraph(lines: readonly string[], structure: MarkdownStructure, fromLine: number, toLine: number): string {
  const collected: string[] = [];
  for (let line = fromLine; line <= toLine; line++) {
    const text = lines[line - 1] ?? '';
    const skip = structure.codeLines[line - 1] === true || text.trim().startsWith('<!--');
    if (structure.headingLines[line - 1] === true) break;
    if (skip || isBlank(text)) {
      if (collected.length > 0) break;
      continue;
    }
    collected.push(text.trim());
  }
  return collapseWhitespace(collected.join(' '));
}

const INLINE_LINK = /\]\(\s*(<[^>\n]*>|[^\s()<>]+(?:\([^\s()]*\)[^\s()<>]*)*)/g;
const REFERENCE_DEFINITION = /^ {0,3}\[[^\]]+\]:\s*(<[^>]*>|\S+)/;
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/** Relative path of a link target without anchor/query, or null for URLs, anchors and absolute paths. */
export function relativeTarget(raw: string): string | null {
  const target = raw.startsWith('<') && raw.endsWith('>') ? raw.slice(1, -1).trim() : raw.trim();
  if (target === '' || SCHEME.test(target) || /^[#/\\{]/.test(target)) return null;
  const path = target.split(/[?#]/)[0] ?? '';
  return path === '' ? null : path;
}

/** Raw link targets on a line (inline links, images and reference definitions); inline code is ignored. */
export function linkTargets(line: string): string[] {
  const text = line.replace(/`+[^`]*`+/g, '');
  const targets = [...text.matchAll(INLINE_LINK)].map((match) => match[1] ?? '');
  const definition = REFERENCE_DEFINITION.exec(text)?.[1];
  return definition ? [...targets, definition] : targets;
}
