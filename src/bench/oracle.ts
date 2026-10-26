/**
 * Independent symbol oracle for benchmark ground truth.
 *
 * It resolves 'path#Qual.Name' references to line ranges with the TypeScript
 * compiler API, deliberately NOT through the Maxify engine, so engine parser
 * bugs cannot hide behind their own output. It mirrors the documented naming
 * convention: members use '.', tests use ' > ', markdown sections use heading text.
 */
import ts from 'typescript';

export interface SymbolSpan {
  qualName: string;
  kind: string;
  /** First line of the declaration, excluding a leading doc comment. */
  startLine: number;
  endLine: number;
}

const TEST_CALLEES = new Set(['describe', 'it', 'test', 'suite']);

function scriptKindFor(path: string): ts.ScriptKind {
  if (path.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (path.endsWith('.ts') || path.endsWith('.mts') || path.endsWith('.cts')) return ts.ScriptKind.TS;
  if (path.endsWith('.jsx')) return ts.ScriptKind.JSX;
  return ts.ScriptKind.JS;
}

function lineOf(source: ts.SourceFile, position: number): number {
  return source.getLineAndCharacterOfPosition(position).line + 1;
}

function span(source: ts.SourceFile, node: ts.Node, qualName: string, kind: string): SymbolSpan {
  return {
    qualName,
    kind,
    startLine: lineOf(source, node.getStart(source)),
    endLine: lineOf(source, node.getEnd()),
  };
}

function memberName(member: ts.ClassElement | ts.TypeElement): string | undefined {
  if (ts.isConstructorDeclaration(member)) return 'constructor';
  const name = member.name;
  if (name === undefined) return undefined;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isPrivateIdentifier(name)) return name.text;
  return undefined;
}

function collectMembers(
  source: ts.SourceFile,
  owner: string,
  members: ts.NodeArray<ts.ClassElement> | ts.NodeArray<ts.TypeElement>,
  out: SymbolSpan[],
): void {
  for (const member of members) {
    const name = memberName(member);
    if (name !== undefined) out.push(span(source, member, `${owner}.${name}`, 'member'));
  }
}

function stringArg(node: ts.CallExpression): string | undefined {
  const first = node.arguments[0];
  if (first !== undefined && (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first))) {
    return first.text;
  }
  return undefined;
}

function calleeName(node: ts.CallExpression): string | undefined {
  const callee = node.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)) return callee.expression.text;
  return undefined;
}

function collectTests(source: ts.SourceFile, statements: readonly ts.Statement[], prefix: string, out: SymbolSpan[]): void {
  for (const statement of statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) continue;
    const call = statement.expression;
    const callee = calleeName(call);
    const title = stringArg(call);
    if (callee === undefined || title === undefined || !TEST_CALLEES.has(callee)) continue;
    const qualName = prefix === '' ? title : `${prefix} > ${title}`;
    out.push(span(source, statement, qualName, callee === 'describe' || callee === 'suite' ? 'suite' : 'test'));
    const body = call.arguments.find((argument) => ts.isArrowFunction(argument) || ts.isFunctionExpression(argument));
    if (body !== undefined && (ts.isArrowFunction(body) || ts.isFunctionExpression(body)) && ts.isBlock(body.body)) {
      collectTests(source, body.body.statements, qualName, out);
    }
  }
}

function collectStatement(source: ts.SourceFile, statement: ts.Statement, out: SymbolSpan[]): void {
  if (ts.isFunctionDeclaration(statement) && statement.name !== undefined) {
    out.push(span(source, statement, statement.name.text, 'function'));
  } else if (ts.isClassDeclaration(statement) && statement.name !== undefined) {
    const name = statement.name.text;
    out.push(span(source, statement, name, 'class'));
    collectMembers(source, name, statement.members, out);
  } else if (ts.isInterfaceDeclaration(statement)) {
    out.push(span(source, statement, statement.name.text, 'interface'));
    collectMembers(source, statement.name.text, statement.members, out);
  } else if (ts.isTypeAliasDeclaration(statement)) {
    out.push(span(source, statement, statement.name.text, 'type'));
  } else if (ts.isEnumDeclaration(statement)) {
    out.push(span(source, statement, statement.name.text, 'enum'));
  } else if (ts.isVariableStatement(statement)) {
    const declarations = statement.declarationList.declarations;
    for (const declaration of declarations) {
      if (!ts.isIdentifier(declaration.name)) continue;
      const node = declarations.length === 1 ? statement : declaration;
      out.push(span(source, node, declaration.name.text, 'variable'));
    }
  }
}

function listCodeSymbols(path: string, text: string): SymbolSpan[] {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, scriptKindFor(path));
  const out: SymbolSpan[] = [];
  for (const statement of source.statements) collectStatement(source, statement, out);
  collectTests(source, source.statements, '', out);
  return out;
}

function listMarkdownSections(text: string): SymbolSpan[] {
  const lines = text.split(/\r?\n/);
  const totalLines = countLines(text);
  const headings: Array<{ title: string; level: number; line: number }> = [];
  let inFence = false;
  lines.forEach((line, index) => {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    const match = inFence ? null : /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (match !== null) headings.push({ title: match[2] ?? '', level: (match[1] ?? '').length, line: index + 1 });
  });
  return headings.map((heading, index) => {
    const next = headings.slice(index + 1).find((candidate) => candidate.level <= heading.level);
    return {
      qualName: heading.title,
      kind: 'section',
      startLine: heading.line,
      endLine: next === undefined ? totalLines : next.line - 1,
    };
  });
}

const CACHE_LIMIT = 256;
const symbolCache = new Map<string, readonly SymbolSpan[]>();

function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16);
}

function compute(path: string, text: string): readonly SymbolSpan[] {
  if (/\.(md|mdx)$/i.test(path)) return listMarkdownSections(text);
  if (/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/i.test(path)) return listCodeSymbols(path, text);
  return [];
}

/**
 * All symbols the oracle can resolve in a file (empty for unsupported file types).
 * Results are memoized by path and content, so repeated lookups never re-parse a file.
 */
export function listSymbols(path: string, text: string): readonly SymbolSpan[] {
  const key = `${path}\0${text.length}\0${fnv1a(text)}`;
  const cached = symbolCache.get(key);
  if (cached !== undefined) return cached;
  const symbols = compute(path, text);
  if (symbolCache.size >= CACHE_LIMIT) {
    const oldest = symbolCache.keys().next().value;
    if (oldest !== undefined) symbolCache.delete(oldest);
  }
  symbolCache.set(key, symbols);
  return symbols;
}

/** Resolves one qualified name; the first declaration wins when a name repeats. */
export function findSymbol(path: string, text: string, qualName: string): SymbolSpan | undefined {
  return listSymbols(path, text).find((symbol) => symbol.qualName === qualName);
}

/** Number of lines of a text (a trailing newline does not add a line). */
export function countLines(text: string): number {
  if (text.length === 0) return 0;
  const lines = text.split(/\r?\n/);
  return text.endsWith('\n') ? lines.length - 1 : lines.length;
}
