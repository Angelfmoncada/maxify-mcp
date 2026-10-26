/**
 * Declaration statements -> symbol drafts: functions, classes, interfaces,
 * type aliases, enums, namespaces (with their members) and variable
 * declarators (function-valued, class-valued, object literals, destructuring).
 */
import ts from 'typescript';
import type { SymbolKind } from '../../core/types.js';
import type { SymbolDraft } from './drafts.js';
import { docInfo, type DocInfo } from './jsdoc.js';
import {
  containsJsx,
  directFunction,
  functionKind,
  isHookName,
  isPascalName,
  typedAsComponent,
  wrappedFunction,
  type FunctionNode,
} from './kinds.js';
import { addClass, addObjectMembers, bodyFlags, modifierFlags, type BuildContext } from './members.js';
import { boundModuleCall } from './module-calls.js';
import {
  functionSignature,
  functionVariableSignature,
  namespaceSignature,
  statementPrefix,
  variableSignature,
} from './signatures.js';
import { hasModifier, unwrapExpression } from './source.js';
import { typeDeclarationSignature } from './type-signatures.js';

function deprecatedFlag(info: DocInfo): string[] {
  return info.deprecated ? ['deprecated'] : [];
}

function exportedAt(parent: SymbolDraft | null, node: ts.Node): boolean {
  return parent === null && hasModifier(node, ts.SyntaxKind.ExportKeyword);
}

function addFunction(ctx: BuildContext, node: ts.FunctionDeclaration, parent: SymbolDraft | null): void {
  const isDefault = hasModifier(node, ts.SyntaxKind.DefaultKeyword);
  const name = node.name?.text ?? (isDefault ? 'default' : '');
  if (name === '') return;
  const info = docInfo(ctx.src, node);
  const jsx = containsJsx(ctx.src, node);
  ctx.sink.add({
    name,
    kind: functionKind(name, jsx),
    start: info.start,
    end: node.end,
    signature: functionSignature(ctx.src, node),
    doc: info.doc,
    flags: [...modifierFlags(node), ...bodyFlags(ctx.src, node), ...deprecatedFlag(info)],
    exportNames: exportedAt(parent, node) ? [isDefault ? 'default' : name] : [],
    parent,
    nodes: [node],
    binds: node.name !== undefined,
  });
}

function addClassDeclaration(ctx: BuildContext, node: ts.ClassDeclaration, parent: SymbolDraft | null): void {
  const isDefault = hasModifier(node, ts.SyntaxKind.DefaultKeyword);
  const name = node.name?.text ?? (isDefault ? 'default' : '');
  if (name === '') return;
  addClass(ctx, node, {
    name,
    parent,
    info: docInfo(ctx.src, node),
    end: node.end,
    nodes: [node],
    exportNames: exportedAt(parent, node) ? [isDefault ? 'default' : name] : [],
    binds: node.name !== undefined,
  });
}

type TypeDeclaration = ts.InterfaceDeclaration | ts.TypeAliasDeclaration | ts.EnumDeclaration;

function typeKind(node: TypeDeclaration): SymbolKind {
  if (ts.isInterfaceDeclaration(node)) return 'interface';
  return ts.isTypeAliasDeclaration(node) ? 'type' : 'enum';
}

function addTypeDeclaration(ctx: BuildContext, node: TypeDeclaration, parent: SymbolDraft | null): void {
  const info = docInfo(ctx.src, node);
  ctx.sink.add({
    name: node.name.text,
    kind: typeKind(node),
    start: info.start,
    end: node.end,
    signature: typeDeclarationSignature(ctx.src, node),
    doc: info.doc,
    flags: [...modifierFlags(node), ...deprecatedFlag(info)],
    exportNames: exportedAt(parent, node) ? [node.name.text] : [],
    parent,
    nodes: [node],
    binds: true,
  });
}

function namespaceName(node: ts.ModuleDeclaration): { name: string; block: ts.ModuleBlock | null } {
  const parts = [node.name.text];
  let body = node.body;
  while (body && ts.isModuleDeclaration(body)) {
    parts.push(body.name.text);
    body = body.body;
  }
  return { name: parts.join('.'), block: body && ts.isModuleBlock(body) ? body : null };
}

function addNamespace(ctx: BuildContext, node: ts.ModuleDeclaration, parent: SymbolDraft | null): void {
  const { name, block } = namespaceName(node);
  const info = docInfo(ctx.src, node);
  const owner = ctx.sink.add({
    name,
    kind: 'namespace',
    start: info.start,
    end: node.end,
    signature: namespaceSignature(ctx.src, node),
    doc: info.doc,
    flags: [...modifierFlags(node), ...deprecatedFlag(info)],
    exportNames: exportedAt(parent, node) ? [name] : [],
    parent,
    nodes: [node],
    container: block,
    // `declare module 'x'` and `declare global` do not bind a name in module scope.
    binds: ts.isIdentifier(node.name) && (node.flags & ts.NodeFlags.GlobalAugmentation) === 0,
  });
  for (const stmt of block?.statements ?? []) addDeclaration(ctx, stmt, owner);
}

interface DeclaratorContext {
  readonly parent: SymbolDraft | null;
  readonly prefix: string;
  readonly exported: boolean;
  readonly info: DocInfo;
  readonly start: number;
  readonly end: number;
  readonly flags: readonly string[];
}

function bindingNames(name: ts.BindingName, out: string[]): string[] {
  if (ts.isIdentifier(name)) {
    out.push(name.text);
  } else {
    for (const element of name.elements) {
      if (ts.isBindingElement(element)) bindingNames(element.name, out);
    }
  }
  return out;
}

interface FunctionShape {
  readonly fn: FunctionNode;
  readonly kind: SymbolKind;
  /** False when the function is only an argument of the initializer call (e.g. withAuth(fn)). */
  readonly symbolIsFunction: boolean;
}

/** Function-valued declarators: direct arrows/functions, or functions wrapped in calls (memo, forwardRef, ...). */
function functionShape(ctx: BuildContext, name: string, decl: ts.VariableDeclaration): FunctionShape | null {
  const componentTyped = typedAsComponent(decl.type);
  const direct = directFunction(decl.initializer);
  if (direct) {
    const kind = functionKind(name, containsJsx(ctx.src, direct), componentTyped);
    return { fn: direct, kind, symbolIsFunction: true };
  }
  const wrapped = wrappedFunction(decl.initializer);
  if (!wrapped) return null;
  if (isHookName(name)) return { fn: wrapped, kind: 'hook', symbolIsFunction: true };
  if (componentTyped || (isPascalName(name) && containsJsx(ctx.src, wrapped))) {
    return { fn: wrapped, kind: 'component', symbolIsFunction: true };
  }
  return { fn: wrapped, kind: 'variable', symbolIsFunction: false };
}

function addNamedDeclarator(ctx: BuildContext, decl: ts.VariableDeclaration, name: string, dc: DeclaratorContext): void {
  const { src, sink } = ctx;
  const init = decl.initializer ? unwrapExpression(decl.initializer) : undefined;
  const base = {
    name,
    start: dc.start,
    end: dc.end,
    doc: dc.info.doc,
    exportNames: dc.exported ? [name] : [],
    parent: dc.parent,
    nodes: [decl],
    binds: true,
  };
  if (init && ts.isClassExpression(init)) {
    addClass(ctx, init, { ...base, info: dc.info, flags: dc.flags, signaturePrefix: `${dc.prefix} ${name} = ` });
    return;
  }
  const shape = functionShape(ctx, name, decl);
  if (shape) {
    sink.add({
      ...base,
      kind: shape.kind,
      signature: functionVariableSignature(src, dc.prefix, decl, shape.fn),
      flags: shape.symbolIsFunction ? [...dc.flags, ...bodyFlags(src, shape.fn)] : dc.flags,
    });
    return;
  }
  const kind: SymbolKind = typedAsComponent(decl.type)
    ? 'component'
    : isHookName(name) && init !== undefined && ts.isCallExpression(init)
      ? 'hook'
      : 'variable';
  const owner = sink.add({
    ...base,
    kind,
    signature: variableSignature(src, dc.prefix, decl),
    flags: dc.flags,
    container: init && ts.isObjectLiteralExpression(init) ? init : null,
  });
  if (init && ts.isObjectLiteralExpression(init)) addObjectMembers(ctx, init, owner);
}

function addVariableStatement(ctx: BuildContext, stmt: ts.VariableStatement, parent: SymbolDraft | null): void {
  const { src } = ctx;
  const info = docInfo(src, stmt);
  const prefix = statementPrefix(src, stmt);
  const exported = exportedAt(parent, stmt);
  const flags = [...modifierFlags(stmt), ...deprecatedFlag(info)];
  const decls = stmt.declarationList.declarations;
  decls.forEach((decl, index) => {
    if (boundModuleCall(decl.initializer)) return;
    const dc: DeclaratorContext = {
      parent,
      prefix,
      exported,
      info,
      start: index === 0 ? info.start : decl.getStart(src.sf),
      end: index === decls.length - 1 ? stmt.end : decl.end,
      flags,
    };
    if (ts.isIdentifier(decl.name)) {
      addNamedDeclarator(ctx, decl, decl.name.text, dc);
      return;
    }
    for (const name of bindingNames(decl.name, [])) {
      ctx.sink.add({
        name,
        kind: 'variable',
        start: dc.start,
        end: dc.end,
        signature: variableSignature(src, prefix, decl),
        doc: info.doc,
        flags,
        exportNames: exported ? [name] : [],
        parent,
        nodes: [decl],
        binds: true,
      });
    }
  });
}

/** Add drafts for a declaration statement. Returns false when `stmt` is not a declaration. */
export function addDeclaration(ctx: BuildContext, stmt: ts.Statement, parent: SymbolDraft | null): boolean {
  if (ts.isFunctionDeclaration(stmt)) addFunction(ctx, stmt, parent);
  else if (ts.isClassDeclaration(stmt)) addClassDeclaration(ctx, stmt, parent);
  else if (ts.isInterfaceDeclaration(stmt) || ts.isTypeAliasDeclaration(stmt) || ts.isEnumDeclaration(stmt)) {
    addTypeDeclaration(ctx, stmt, parent);
  } else if (ts.isModuleDeclaration(stmt)) addNamespace(ctx, stmt, parent);
  else if (ts.isVariableStatement(stmt)) addVariableStatement(ctx, stmt, parent);
  else return false;
  return true;
}
