/**
 * Simple lexical scope tracking for reference attribution. A scope maps names
 * to what they mean inside it: a local binding that shadows outer names
 * (with value/type meaning), a binding of an imported module (local
 * `const x = require('m')`), or a namespace member symbol.
 */
import ts from 'typescript';
import type { ParsedImport } from '../../core/types.js';
import { boundModuleCall } from './module-calls.js';

const {
  NodeFlags,
  SyntaxKind,
  forEachChild,
  isBindingElement,
  isBlock,
  isClassDeclaration,
  isEnumDeclaration,
  isFunctionDeclaration,
  isFunctionExpression,
  isIdentifier,
  isInferTypeNode,
  isInterfaceDeclaration,
  isModuleDeclaration,
  isTypeAliasDeclaration,
  isVariableDeclarationList,
  isVariableStatement,
} = ts;

export const VALUE = 1;
export const TYPE = 2;
const BOTH = VALUE | TYPE;

export interface ImportRef {
  readonly importIndex: number;
  readonly imported: string;
}

export type Binding =
  | { readonly kind: 'shadow'; readonly meaning: number }
  | { readonly kind: 'import'; readonly ref: ImportRef }
  | { readonly kind: 'symbol'; readonly symbol: number };

export type Scope = ReadonlyMap<string, Binding>;

/** What scope construction needs to know about the file. */
export interface ScopeIndex {
  readonly imports: readonly ParsedImport[];
  /** require()/import() call or import type node -> index of the ParsedImport it produced. */
  readonly nodeToImport: ReadonlyMap<ts.Node, number>;
  /** Namespace body (ModuleBlock) -> member names bound to their symbols. */
  readonly namespaceScopes: ReadonlyMap<ts.Node, Scope>;
}

const FUNCTION_SCOPES = new Set<ts.SyntaxKind>([
  SyntaxKind.FunctionDeclaration,
  SyntaxKind.FunctionExpression,
  SyntaxKind.ArrowFunction,
  SyntaxKind.MethodDeclaration,
  SyntaxKind.Constructor,
  SyntaxKind.GetAccessor,
  SyntaxKind.SetAccessor,
]);
const TYPE_PARAMETER_SCOPES = new Set<ts.SyntaxKind>([
  SyntaxKind.InterfaceDeclaration,
  SyntaxKind.TypeAliasDeclaration,
  SyntaxKind.MethodSignature,
  SyntaxKind.CallSignature,
  SyntaxKind.ConstructSignature,
  SyntaxKind.FunctionType,
  SyntaxKind.ConstructorType,
]);
/** Every node kind that can introduce a scope (cheap pre-check for the walker). */
export const SCOPE_KINDS: ReadonlySet<ts.SyntaxKind> = new Set<ts.SyntaxKind>([
  ...FUNCTION_SCOPES,
  ...TYPE_PARAMETER_SCOPES,
  SyntaxKind.Block,
  SyntaxKind.CaseBlock,
  SyntaxKind.ForStatement,
  SyntaxKind.ForInStatement,
  SyntaxKind.ForOfStatement,
  SyntaxKind.CatchClause,
  SyntaxKind.ClassDeclaration,
  SyntaxKind.ClassExpression,
  SyntaxKind.MappedType,
  SyntaxKind.ConditionalType,
  SyntaxKind.ModuleBlock,
]);
const STATEMENT_CONTAINERS = new Set<ts.SyntaxKind>([
  SyntaxKind.Block,
  SyntaxKind.IfStatement,
  SyntaxKind.ForStatement,
  SyntaxKind.ForInStatement,
  SyntaxKind.ForOfStatement,
  SyntaxKind.WhileStatement,
  SyntaxKind.DoStatement,
  SyntaxKind.TryStatement,
  SyntaxKind.CatchClause,
  SyntaxKind.SwitchStatement,
  SyntaxKind.CaseBlock,
  SyntaxKind.CaseClause,
  SyntaxKind.DefaultClause,
  SyntaxKind.LabeledStatement,
  SyntaxKind.WithStatement,
  SyntaxKind.VariableStatement,
]);
const BLOCK_SCOPED = NodeFlags.BlockScoped;

type MutableScope = Map<string, Binding>;

function shadow(scope: MutableScope, name: string, meaning: number): void {
  const previous = scope.get(name);
  if (!previous) scope.set(name, { kind: 'shadow', meaning });
  else if (previous.kind === 'shadow') scope.set(name, { kind: 'shadow', meaning: previous.meaning | meaning });
}

function addPattern(scope: MutableScope, name: ts.BindingName, meaning: number): void {
  if (isIdentifier(name)) {
    shadow(scope, name.text, meaning);
    return;
  }
  for (const element of name.elements) {
    if (isBindingElement(element)) addPattern(scope, element.name, meaning);
  }
}

function addDeclarator(scope: MutableScope, decl: ts.VariableDeclaration, ix: ScopeIndex): void {
  const bound = boundModuleCall(decl.initializer);
  const importIndex = bound ? ix.nodeToImport.get(bound.call) : undefined;
  if (importIndex !== undefined) {
    for (const binding of ix.imports[importIndex]?.bindings ?? []) {
      if (binding.local !== '') scope.set(binding.local, { kind: 'import', ref: { importIndex, imported: binding.imported } });
    }
  }
  addPattern(scope, decl.name, VALUE);
}

function addDeclarationList(scope: MutableScope, list: ts.VariableDeclarationList, ix: ScopeIndex): void {
  for (const decl of list.declarations) addDeclarator(scope, decl, ix);
}

/** `var` declarations anywhere in a function body (not crossing nested functions). */
function collectVars(node: ts.Node, scope: MutableScope, ix: ScopeIndex): void {
  forEachChild(node, (child) => {
    if (isVariableDeclarationList(child)) {
      if ((child.flags & BLOCK_SCOPED) === 0) addDeclarationList(scope, child, ix);
    } else if (STATEMENT_CONTAINERS.has(child.kind)) {
      collectVars(child, scope, ix);
    }
  });
}

function addTypeParameters(scope: MutableScope, params: ts.NodeArray<ts.TypeParameterDeclaration> | undefined): void {
  for (const param of params ?? []) shadow(scope, param.name.text, TYPE);
}

function functionScope(fn: ts.FunctionLikeDeclaration, ix: ScopeIndex): MutableScope {
  const scope: MutableScope = new Map();
  if (isFunctionExpression(fn) && fn.name) shadow(scope, fn.name.text, VALUE);
  addTypeParameters(scope, fn.typeParameters);
  for (const param of fn.parameters) addPattern(scope, param.name, VALUE);
  if (fn.body && isBlock(fn.body)) collectVars(fn.body, scope, ix);
  return scope;
}

function statementsScope(statements: readonly ts.Statement[], ix: ScopeIndex): MutableScope {
  const scope: MutableScope = new Map();
  for (const stmt of statements) {
    if (isVariableStatement(stmt)) addDeclarationList(scope, stmt.declarationList, ix);
    else if (isFunctionDeclaration(stmt) && stmt.name) shadow(scope, stmt.name.text, VALUE);
    else if ((isClassDeclaration(stmt) || isEnumDeclaration(stmt)) && stmt.name) shadow(scope, stmt.name.text, BOTH);
    else if (isInterfaceDeclaration(stmt) || isTypeAliasDeclaration(stmt)) shadow(scope, stmt.name.text, TYPE);
    else if (isModuleDeclaration(stmt) && isIdentifier(stmt.name)) shadow(scope, stmt.name.text, BOTH);
  }
  return scope;
}

function inferScope(node: ts.ConditionalTypeNode): MutableScope {
  const scope: MutableScope = new Map();
  const visit = (child: ts.Node): void => {
    if (isInferTypeNode(child)) shadow(scope, child.typeParameter.name.text, TYPE);
    forEachChild(child, visit);
  };
  visit(node.extendsType);
  return scope;
}

function classScope(node: ts.ClassLikeDeclaration): MutableScope {
  const scope: MutableScope = new Map();
  if (node.kind === SyntaxKind.ClassExpression && node.name) shadow(scope, node.name.text, BOTH);
  addTypeParameters(scope, node.typeParameters);
  return scope;
}

function forScope(node: ts.ForStatement | ts.ForInStatement | ts.ForOfStatement, ix: ScopeIndex): MutableScope {
  const scope: MutableScope = new Map();
  const init = node.initializer;
  if (init && isVariableDeclarationList(init)) addDeclarationList(scope, init, ix);
  return scope;
}

function singleTypeParameter(name: string): MutableScope {
  const scope: MutableScope = new Map();
  shadow(scope, name, TYPE);
  return scope;
}

function buildScope(node: ts.Node, ix: ScopeIndex): Scope | null {
  const kind = node.kind;
  if (FUNCTION_SCOPES.has(kind)) return functionScope(node as ts.FunctionLikeDeclaration, ix);
  if (TYPE_PARAMETER_SCOPES.has(kind)) {
    const scope: MutableScope = new Map();
    addTypeParameters(scope, (node as ts.SignatureDeclarationBase | ts.InterfaceDeclaration).typeParameters);
    return scope;
  }
  switch (kind) {
    case SyntaxKind.Block:
      return statementsScope((node as ts.Block).statements, ix);
    case SyntaxKind.CaseBlock:
      return statementsScope((node as ts.CaseBlock).clauses.flatMap((clause) => [...clause.statements]), ix);
    case SyntaxKind.ForStatement:
    case SyntaxKind.ForInStatement:
    case SyntaxKind.ForOfStatement:
      return forScope(node as ts.ForStatement | ts.ForInStatement | ts.ForOfStatement, ix);
    case SyntaxKind.CatchClause: {
      const scope: MutableScope = new Map();
      const variable = (node as ts.CatchClause).variableDeclaration;
      if (variable) addPattern(scope, variable.name, VALUE);
      return scope;
    }
    case SyntaxKind.ClassDeclaration:
    case SyntaxKind.ClassExpression:
      return classScope(node as ts.ClassLikeDeclaration);
    case SyntaxKind.MappedType:
      return singleTypeParameter((node as ts.MappedTypeNode).typeParameter.name.text);
    case SyntaxKind.ConditionalType:
      return inferScope(node as ts.ConditionalTypeNode);
    case SyntaxKind.ModuleBlock:
      return ix.namespaceScopes.get(node) ?? null;
    default:
      return null;
  }
}

/** The scope `node` introduces for its subtree, or null when it introduces none (or an empty one). */
export function scopeFor(node: ts.Node, ix: ScopeIndex): Scope | null {
  const scope = buildScope(node, ix);
  return scope && scope.size > 0 ? scope : null;
}
