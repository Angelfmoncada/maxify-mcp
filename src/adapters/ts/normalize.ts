/**
 * Token-level normalization of code excerpts used for signatures.
 *
 * Re-scans the excerpt with the TypeScript scanner so that comments are
 * dropped, every whitespace run becomes a single space (string and template
 * literals stay intact) and multi-line formatting artifacts disappear:
 * no space after '(' / '[' / '.', none before ')' / ']' / ',' / ';' / '.',
 * and trailing commas before a closing bracket are removed.
 */
import ts from 'typescript';

const { SyntaxKind } = ts;
const TRIVIA = new Set<ts.SyntaxKind>([
  SyntaxKind.WhitespaceTrivia,
  SyntaxKind.NewLineTrivia,
  SyntaxKind.SingleLineCommentTrivia,
  SyntaxKind.MultiLineCommentTrivia,
  SyntaxKind.ShebangTrivia,
  SyntaxKind.ConflictMarkerTrivia,
]);
const END_OF_FILE = SyntaxKind.EndOfFileToken;
const OPEN_BRACE = SyntaxKind.OpenBraceToken;
const CLOSE_BRACE = SyntaxKind.CloseBraceToken;
const TEMPLATE_HEAD = SyntaxKind.TemplateHead;
const TEMPLATE_TAIL = SyntaxKind.TemplateTail;
const NO_SPACE_AFTER = new Set(['(', '[', '.', '?.']);
const NO_SPACE_BEFORE = new Set([')', ']', ',', ';', '.', '?.']);
const CLOSERS = new Set([')', ']', '}']);

interface Token {
  readonly text: string;
  readonly spaced: boolean;
}

let sharedScanner: ts.Scanner | undefined;

function scannerFor(text: string): ts.Scanner {
  sharedScanner ??= ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard);
  sharedScanner.setText(text);
  return sharedScanner;
}

function tokenize(text: string): Token[] {
  const scanner = scannerFor(text);
  const tokens: Token[] = [];
  const templateDepths: number[] = [];
  let depth = 0;
  let spaced = false;
  for (let kind = scanner.scan(); kind !== END_OF_FILE; kind = scanner.scan()) {
    if (TRIVIA.has(kind)) {
      spaced = true;
      continue;
    }
    if (kind === OPEN_BRACE) {
      depth++;
    } else if (kind === CLOSE_BRACE) {
      if (templateDepths.length > 0 && templateDepths[templateDepths.length - 1] === depth) {
        if (scanner.reScanTemplateToken(false) === TEMPLATE_TAIL) templateDepths.pop();
      } else {
        depth--;
      }
    } else if (kind === TEMPLATE_HEAD) {
      templateDepths.push(depth);
    }
    tokens.push({ text: scanner.getTokenText(), spaced });
    spaced = false;
  }
  scanner.setText('');
  return tokens;
}

/** Normalize a code excerpt to a single line (see module doc). */
export function normalizeCode(text: string): string {
  const tokens = tokenize(text);
  let out = '';
  let prev = '';
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token) continue;
    if (token.text === ',' && CLOSERS.has(tokens[i + 1]?.text ?? '')) continue;
    if (out !== '' && token.spaced && !NO_SPACE_AFTER.has(prev) && !NO_SPACE_BEFORE.has(token.text)) out += ' ';
    out += token.text;
    prev = token.text;
  }
  return out;
}

/** Normalize and strip a trailing ';' or ','. */
export function normalizeMember(text: string): string {
  return normalizeCode(text).replace(/[;,]+$/, '');
}
