/**
 * Module dependencies and unresolvable dynamic constructs, collected in one
 * walk over the whole tree (imports can appear inside functions):
 * ES imports/re-exports, import-equals, require(), import(), import types
 * (also inside JSDoc in JavaScript files), and 'unresolved' records for
 * computed requires/imports, eval, glob imports, computed calls and dynamic
 * CommonJS exports.
 */
import ts from 'typescript';
import type { ImportBinding, ImportKind, ParsedUnresolved, UnresolvedKind } from '../../core/types.js';
import { isExportsObject } from './cjs.js';
import { rawJsDocs } from './jsdoc.js';
import { boundModuleCall, isImportCall, isRequireCall, literalSpecifier } from './module-calls.js';
import {
  excerpt,
  isStaticString,
  MAX_WALK_DEPTH,
  propertyNameText,
  unwrapExpression,
  type TsSource,
} from './source.js';

export interface ImportDraft {
  readonly pos: number;
  readonly spec: string;
  readonly kind: ImportKind;
  readonly bindings: readonly ImportBinding[];
  readonly line: number;
  /** require()/import() call or import type node this import came from (maps refs back to it). */
  readonly node: ts.Node | null;
  /** True when the bindings are declared at module scope. */
  readonly topLevel: boolean;
}

export interface ImportScan {
  readonly imports: readonly ImportDraft[];
  readonly unresolved: readonly ParsedUnresolved[];
}

const { SyntaxKind, forEachChild } = ts;
const IMPORT_DECLARATION = SyntaxKind.ImportDeclaration;
const EXPORT_DECLARATION = SyntaxKind.ExportDeclaration;
const IMPORT_EQUALS = SyntaxKind.ImportEqualsDeclaration;
const CALL_EXPRESSION = SyntaxKind.CallExpression;
const NEW_EXPRESSION = SyntaxKind.NewExpression;
const BINARY_EXPRESSION = SyntaxKind.BinaryExpression;
/** Node kinds the walker inspects; all others are only descended into. */
const INSPECTED = new Set<ts.SyntaxKind>([
  IMPORT_DECLARATION,
  EXPORT_DECLARATION,
  IMPORT_EQUALS,
  CALL_EXPRESSION,
  NEW_EXPRESSION,
  BINARY_EXPRESSION,
  SyntaxKind.ImportType,
]);
const GLOBAL_OBJECTS = new Set(['window', 'globalThis', 'global', 'self']);
const GLOBBERS = new Set(['glob', 'globEager', 'webpackContext']);
const DECLARATOR_CLIMB = 6;

function exportNameText(name: ts.ModuleExportName): string {
  return name.text;
}

function clauseBindings(clause: ts.ImportClause, typeOnly: boolean): ImportBinding[] {
  const bindings: ImportBinding[] = [];
  if (clause.name) bindings.push({ imported: 'default', local: clause.name.text, typeOnly });
  const named = clause.namedBindings;
  if (named && ts.isNamespaceImport(named)) bindings.push({ imported: '*', local: named.name.text, typeOnly });
  if (named && ts.isNamedImports(named)) {
    for (const el of named.elements) {
      const imported = exportNameText(el.propertyName ?? el.name);
      bindings.push({ imported, local: el.name.text, typeOnly: typeOnly || el.isTypeOnly });
    }
  }
  return bindings;
}

function exportBindings(node: ts.ExportDeclaration): { kind: ImportKind; bindings: ImportBinding[] } {
  const typeOnly = node.isTypeOnly;
  const clause = node.exportClause;
  if (!clause) return { kind: 'reexport-all', bindings: [{ imported: '*', local: '', typeOnly }] };
  if (ts.isNamespaceExport(clause)) {
    return { kind: 'reexport', bindings: [{ imported: '*', local: exportNameText(clause.name), typeOnly }] };
  }
  const bindings = clause.elements.map((el) => ({
    imported: exportNameText(el.propertyName ?? el.name),
    local: exportNameText(el.name),
    typeOnly: typeOnly || el.isTypeOnly,
  }));
  return { kind: 'reexport', bindings };
}

/** The variable declarator that binds the result of a require()/import() call, if any. */
function declaratorOf(call: ts.CallExpression): { decl: ts.VariableDeclaration; member: string | null } | null {
  let node: ts.Node = call;
  for (let i = 0; i < DECLARATOR_CLIMB; i++) {
    const parent: ts.Node | undefined = node.parent;
    if (!parent) return null;
    if (ts.isVariableDeclaration(parent)) {
      const bound = boundModuleCall(parent.initializer);
      return bound && bound.call === call ? { decl: parent, member: bound.member } : null;
    }
    node = parent;
  }
  return null;
}

function patternBindings(src: TsSource, pattern: ts.ObjectBindingPattern): ImportBinding[] {
  return pattern.elements.flatMap((el): ImportBinding[] => {
    if (!ts.isIdentifier(el.name)) return [];
    if (el.dotDotDotToken) return [{ imported: '*', local: el.name.text, typeOnly: false }];
    if (el.propertyName && ts.isComputedPropertyName(el.propertyName)) return [];
    const imported = el.propertyName ? propertyNameText(src, el.propertyName) : el.name.text;
    return [{ imported, local: el.name.text, typeOnly: false }];
  });
}

function callBindings(src: TsSource, call: ts.CallExpression): { bindings: ImportBinding[]; topLevel: boolean } {
  const bound = declaratorOf(call);
  if (!bound) return { bindings: [], topLevel: false };
  const { decl, member } = bound;
  const topLevel = ts.isVariableStatement(decl.parent.parent) && decl.parent.parent.parent === src.sf;
  if (ts.isIdentifier(decl.name)) return { bindings: [{ imported: member ?? '*', local: decl.name.text, typeOnly: false }], topLevel };
  if (member === null && ts.isObjectBindingPattern(decl.name)) return { bindings: patternBindings(src, decl.name), topLevel };
  return { bindings: [], topLevel };
}

function leftmostName(name: ts.EntityName): string {
  return ts.isIdentifier(name) ? name.text : leftmostName(name.left);
}

function isComputedAccess(node: ts.Node): boolean {
  return (
    ts.isElementAccessExpression(node) &&
    !isStaticString(node.argumentExpression) &&
    !ts.isNumericLiteral(node.argumentExpression)
  );
}

function specialCallKind(call: ts.CallExpression): UnresolvedKind | null {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return callee.text === 'eval' || callee.text === 'Function' ? 'eval' : null;
  if (ts.isPropertyAccessExpression(callee)) {
    const name = callee.name.text;
    const obj = callee.expression;
    if (GLOBBERS.has(name) && ts.isMetaProperty(obj) && obj.keywordToken === ts.SyntaxKind.ImportKeyword) return 'glob-import';
    if (name === 'context' && ts.isIdentifier(obj) && obj.text === 'require') return 'glob-import';
    if (name === 'eval' && ts.isIdentifier(obj) && GLOBAL_OBJECTS.has(obj.text)) return 'eval';
    if ((name === 'call' || name === 'apply') && isComputedAccess(unwrapExpression(obj))) return 'computed-call';
    return null;
  }
  return isComputedAccess(callee) ? 'computed-call' : null;
}

/** Collect imports and unresolved constructs in document order. */
export function scanImports(src: TsSource): ImportScan {
  const imports: ImportDraft[] = [];
  const unresolved: ParsedUnresolved[] = [];
  const startOf = (node: ts.Node): number => node.getStart(src.sf);
  const add = (node: ts.Node, spec: string, kind: ImportKind, bindings: ImportBinding[], extra: Partial<ImportDraft> = {}): void => {
    const pos = startOf(node);
    imports.push({ pos, spec, kind, bindings, line: src.line(pos), node: null, topLevel: false, ...extra });
  };
  const flag = (node: ts.Node, kind: UnresolvedKind): void => {
    unresolved.push({ line: src.line(startOf(node)), kind, detail: excerpt(src, node) });
  };

  const importLike = (node: ts.ImportDeclaration | ts.JSDocImportTag, forceType: boolean): void => {
    if (!ts.isStringLiteral(node.moduleSpecifier)) return;
    const spec = node.moduleSpecifier.text;
    const clause = node.importClause;
    if (!clause) {
      add(node, spec, forceType ? 'import-type' : 'side-effect', []);
      return;
    }
    const typeOnly = forceType || clause.phaseModifier === ts.SyntaxKind.TypeKeyword;
    add(node, spec, typeOnly ? 'import-type' : 'import', clauseBindings(clause, typeOnly), {
      topLevel: !forceType && node.parent === src.sf,
    });
  };

  const importType = (node: ts.ImportTypeNode): void => {
    const arg = node.argument;
    if (!ts.isLiteralTypeNode(arg) || !ts.isStringLiteral(arg.literal)) return;
    const imported = node.qualifier ? leftmostName(node.qualifier) : '*';
    add(node, arg.literal.text, 'import-type', [{ imported, local: '', typeOnly: true }], { node });
  };

  const call = (node: ts.CallExpression): void => {
    const loader = isRequireCall(node) ? 'require' : isImportCall(node) ? 'dynamic-import' : null;
    if (loader === null) {
      const special = specialCallKind(node);
      if (special) flag(node, special);
      return;
    }
    if (node.arguments.length === 0) return;
    const spec = literalSpecifier(node);
    if (spec === null) {
      flag(node, loader === 'require' ? 'dynamic-require' : 'dynamic-import');
      return;
    }
    const { bindings, topLevel } = callBindings(src, node);
    add(node, spec, loader, bindings, { node, topLevel });
  };

  const assignment = (node: ts.BinaryExpression): void => {
    if (node.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return;
    const left = node.left;
    if (ts.isElementAccessExpression(left) && isExportsObject(left.expression) && isComputedAccess(left)) {
      flag(node, 'commonjs-dynamic');
    }
  };

  const walkJsDoc = (node: ts.Node): void => {
    if (ts.isImportTypeNode(node)) importType(node);
    else if (ts.isJSDocImportTag(node)) importLike(node, true);
    forEachChild(node, walkJsDoc);
  };

  const exportFrom = (node: ts.ExportDeclaration): void => {
    if (!node.moduleSpecifier || !ts.isStringLiteral(node.moduleSpecifier)) return;
    const { kind, bindings } = exportBindings(node);
    add(node, node.moduleSpecifier.text, kind, bindings);
  };

  const importEquals = (node: ts.ImportEqualsDeclaration): void => {
    const ref = node.moduleReference;
    if (!ts.isExternalModuleReference(ref) || !ts.isStringLiteral(ref.expression)) return;
    const binding = { imported: '*', local: node.name.text, typeOnly: node.isTypeOnly };
    add(node, ref.expression.text, 'require', [binding], { topLevel: node.parent === src.sf });
  };

  const newExpression = (node: ts.NewExpression): void => {
    if (ts.isIdentifier(node.expression) && node.expression.text === 'Function') flag(node, 'eval');
  };

  let depth = 0;
  const descend = (node: ts.Node): void => {
    if (depth >= MAX_WALK_DEPTH) return;
    depth++;
    forEachChild(node, visit);
    depth--;
  };

  const visit = (node: ts.Node): void => {
    if (src.isJs) for (const doc of rawJsDocs(node)) walkJsDoc(doc);
    const kind = node.kind;
    if (!INSPECTED.has(kind)) return descend(node);
    if (kind === IMPORT_DECLARATION) return importLike(node as ts.ImportDeclaration, false);
    if (kind === EXPORT_DECLARATION) return exportFrom(node as ts.ExportDeclaration);
    if (kind === IMPORT_EQUALS) return importEquals(node as ts.ImportEqualsDeclaration);
    if (kind === CALL_EXPRESSION) call(node as ts.CallExpression);
    else if (kind === NEW_EXPRESSION) newExpression(node as ts.NewExpression);
    else if (kind === BINARY_EXPRESSION) assignment(node as ts.BinaryExpression);
    else importType(node as ts.ImportTypeNode);
    descend(node);
  };

  descend(src.sf);
  return { imports, unresolved };
}
