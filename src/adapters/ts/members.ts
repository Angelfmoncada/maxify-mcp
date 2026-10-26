/**
 * Classes and their members, and function-valued members of object literals
 * (`const api = { list() {}, get: () => {} }` -> 'api.list', 'api.get').
 */
import ts from 'typescript';
import type { SymbolKind } from '../../core/types.js';
import { withFlag, type DraftSink, type SymbolDraft } from './drafts.js';
import { docInfo, type DocInfo } from './jsdoc.js';
import { containsJsx, directFunction, isAsync, type FunctionNode } from './kinds.js';
import { classSignature, memberSignature } from './signatures.js';
import { propertyNameText, type TsSource } from './source.js';

export interface BuildContext {
  readonly src: TsSource;
  readonly sink: DraftSink;
}

const MODIFIER_FLAGS: ReadonlyArray<readonly [ts.SyntaxKind, string]> = [
  [ts.SyntaxKind.AsyncKeyword, 'async'],
  [ts.SyntaxKind.AbstractKeyword, 'abstract'],
  [ts.SyntaxKind.StaticKeyword, 'static'],
  [ts.SyntaxKind.PrivateKeyword, 'private'],
  [ts.SyntaxKind.ProtectedKeyword, 'protected'],
  [ts.SyntaxKind.ReadonlyKeyword, 'readonly'],
  [ts.SyntaxKind.DeclareKeyword, 'declare'],
];

/** Flags for the modifiers present on `node`. */
export function modifierFlags(node: ts.Node): string[] {
  const modifiers = ts.canHaveModifiers(node) ? (ts.getModifiers(node) ?? []) : [];
  return MODIFIER_FLAGS.filter(([kind]) => modifiers.some((m) => m.kind === kind)).map(([, flag]) => flag);
}

/** async / generator / jsx flags of a function body. */
export function bodyFlags(src: TsSource, fn: ts.FunctionLikeDeclaration): string[] {
  const flags: string[] = [];
  if (isAsync(fn)) flags.push('async');
  if (fn.asteriskToken) flags.push('generator');
  if (containsJsx(src, fn)) flags.push('jsx');
  return flags;
}

export interface ClassOptions {
  readonly name: string;
  readonly parent: SymbolDraft | null;
  readonly info: DocInfo;
  readonly end: number;
  readonly nodes: readonly ts.Node[];
  readonly exportNames?: readonly string[];
  readonly flags?: readonly string[];
  readonly signaturePrefix?: string;
  readonly binds: boolean;
  readonly qual?: string;
}

interface MemberShape {
  readonly kind: SymbolKind;
  readonly fn: ts.FunctionLikeDeclaration;
}

/** Add a class symbol and its members (each member signature is computed once). */
export function addClass(ctx: BuildContext, node: ts.ClassLikeDeclaration, options: ClassOptions): SymbolDraft {
  const { src, sink } = ctx;
  const members = node.members.map((member) => ({
    member,
    shape: classMemberKind(member),
    signature: memberSignature(src, member),
  }));
  const jsx = members.some(({ member, shape }) => containsJsx(src, shape ? shape.fn : member));
  const flags = withFlag(withFlag([...(options.flags ?? []), ...modifierFlags(node)], 'jsx', jsx), 'deprecated', options.info.deprecated);
  const owner = sink.add({
    name: options.name,
    qual: options.qual,
    kind: 'class',
    start: options.info.start,
    end: options.end,
    signature: classSignature(src, node, options.signaturePrefix ?? '', members.map((m) => m.signature)),
    doc: options.info.doc,
    flags,
    exportNames: options.exportNames,
    parent: options.parent,
    nodes: options.nodes,
    container: node,
    binds: options.binds,
  });
  for (const { member, shape, signature } of members) {
    if (shape) addClassMember(ctx, member, shape, signature ?? '', owner);
  }
  return owner;
}

function classMemberKind(member: ts.ClassElement): MemberShape | null {
  if (ts.isMethodDeclaration(member)) return { kind: 'method', fn: member };
  if (ts.isConstructorDeclaration(member)) return { kind: 'constructor', fn: member };
  if (ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member)) return { kind: 'accessor', fn: member };
  if (ts.isPropertyDeclaration(member)) {
    const fn = directFunction(member.initializer);
    return fn ? { kind: 'property', fn } : null;
  }
  return null;
}

function accessorFlags(member: ts.Node): string[] {
  if (ts.isGetAccessorDeclaration(member)) return ['get'];
  if (ts.isSetAccessorDeclaration(member)) return ['set'];
  return [];
}

function addClassMember(ctx: BuildContext, member: ts.ClassElement, shape: MemberShape, signature: string, owner: SymbolDraft): void {
  const { src, sink } = ctx;
  const name = ts.isConstructorDeclaration(member) || !member.name ? 'constructor' : propertyNameText(src, member.name);
  const info = docInfo(src, member);
  const privateName = member.name !== undefined && ts.isPrivateIdentifier(member.name);
  const flags = [
    ...modifierFlags(member),
    ...bodyFlags(src, shape.fn),
    ...accessorFlags(member),
    ...(privateName ? ['private'] : []),
    ...(info.deprecated ? ['deprecated'] : []),
  ];
  sink.add({
    name,
    kind: shape.kind,
    start: info.start,
    end: member.end,
    signature,
    doc: info.doc,
    flags,
    parent: owner,
    nodes: [member],
  });
}

function objectMemberShape(
  member: ts.ObjectLiteralElementLike,
): { kind: SymbolKind; fn: ts.FunctionLikeDeclaration; name: ts.PropertyName } | null {
  if (ts.isMethodDeclaration(member)) return { kind: 'method', fn: member, name: member.name };
  if (ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member)) {
    return { kind: 'accessor', fn: member, name: member.name };
  }
  if (ts.isPropertyAssignment(member)) {
    const fn: FunctionNode | null = directFunction(member.initializer);
    return fn ? { kind: 'method', fn, name: member.name } : null;
  }
  return null;
}

/** Function-valued members of an object literal as children of `owner`. */
export function addObjectMembers(ctx: BuildContext, obj: ts.ObjectLiteralExpression, owner: SymbolDraft): void {
  const { src, sink } = ctx;
  for (const member of obj.properties) {
    const shape = objectMemberShape(member);
    if (!shape) continue;
    const info = docInfo(src, member);
    sink.add({
      name: propertyNameText(src, shape.name),
      kind: shape.kind,
      start: info.start,
      end: member.end,
      signature: memberSignature(src, member) ?? '',
      doc: info.doc,
      flags: [...bodyFlags(src, shape.fn), ...accessorFlags(member), ...(info.deprecated ? ['deprecated'] : [])],
      parent: owner,
      nodes: [member],
    });
  }
}
