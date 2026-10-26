/**
 * Same-file references: every identifier that names an import binding or a
 * symbol of this file, attributed to the innermost enclosing symbol and
 * classified as calls / renders / extends / implements / uses-type /
 * references. Declaration names, property names, object keys, JSX attribute
 * names and names shadowed by local bindings are never reported.
 *
 * TypeScript helpers are bound once at module load: this walker visits every
 * node, and `ts.<name>` lookups go through accessor properties.
 */
import ts from 'typescript';
import type { ParsedRef, RefKind, RefTarget } from '../../core/types.js';
import { scopeFor, SCOPE_KINDS, TYPE, VALUE, type ImportRef, type Scope, type ScopeIndex } from './scopes.js';
import { isStaticString, MAX_WALK_DEPTH, type TsSource } from './source.js';

const {
  SyntaxKind,
  forEachChild,
  isBinaryExpression,
  isBindingElement,
  isBreakOrContinueStatement,
  isCallExpression,
  isDecorator,
  isElementAccessExpression,
  isExpressionWithTypeArguments,
  isHeritageClause,
  isIdentifier,
  isImportTypeNode,
  isInterfaceDeclaration,
  isJsxOpeningElement,
  isJsxSelfClosingElement,
  isLabeledStatement,
  isNewExpression,
  isObjectLiteralExpression,
  isPropertyAccessExpression,
  isQualifiedName,
  isTaggedTemplateExpression,
  isTypeNode,
  isTypePredicateNode,
} = ts;

export interface RefIndex extends ScopeIndex {
  /** Syntax node -> symbol whose subtree it starts. */
  readonly nodeToSymbol: ReadonlyMap<ts.Node, number>;
  /** Symbol -> its children by name (class members, object members, namespace members). */
  readonly members: ReadonlyMap<number, ReadonlyMap<string, number>>;
  /** Class / object literal / object-member function node -> members visible through `this`. */
  readonly thisMaps: ReadonlyMap<ts.Node, ReadonlyMap<string, number>>;
  /** Top-level bindings by name, preferring value-meaning or type-meaning declarations. */
  readonly valueNames: ReadonlyMap<string, number>;
  readonly typeNames: ReadonlyMap<string, number>;
  /** Module-scope import bindings by local name. */
  readonly moduleImports: ReadonlyMap<string, ImportRef>;
  /** CommonJS export name -> symbol, for `exports.x` / `module.exports.x` accesses. */
  readonly cjsExports: ReadonlyMap<string, number>;
}

const DECLARATION_KINDS = new Set<ts.SyntaxKind>([
  SyntaxKind.VariableDeclaration,
  SyntaxKind.Parameter,
  SyntaxKind.FunctionDeclaration,
  SyntaxKind.FunctionExpression,
  SyntaxKind.ClassDeclaration,
  SyntaxKind.ClassExpression,
  SyntaxKind.InterfaceDeclaration,
  SyntaxKind.TypeAliasDeclaration,
  SyntaxKind.EnumDeclaration,
  SyntaxKind.EnumMember,
  SyntaxKind.ModuleDeclaration,
  SyntaxKind.TypeParameter,
  SyntaxKind.ImportEqualsDeclaration,
  SyntaxKind.PropertyAssignment,
  SyntaxKind.PropertyDeclaration,
  SyntaxKind.PropertySignature,
  SyntaxKind.MethodDeclaration,
  SyntaxKind.MethodSignature,
  SyntaxKind.GetAccessor,
  SyntaxKind.SetAccessor,
  SyntaxKind.JsxAttribute,
  SyntaxKind.NamedTupleMember,
]);
const NEVER_REFERENCES = new Set<ts.SyntaxKind>([
  SyntaxKind.ImportSpecifier,
  SyntaxKind.ExportSpecifier,
  SyntaxKind.ImportClause,
  SyntaxKind.NamespaceImport,
  SyntaxKind.NamespaceExport,
  SyntaxKind.NamespaceExportDeclaration,
  SyntaxKind.MetaProperty,
  SyntaxKind.JsxClosingElement,
  SyntaxKind.JsxNamespacedName,
]);
const SKIPPED_SUBTREES = new Set<ts.SyntaxKind>([
  SyntaxKind.ImportDeclaration,
  SyntaxKind.ImportEqualsDeclaration,
  SyntaxKind.ExportDeclaration,
  SyntaxKind.JsxClosingElement,
]);
const WRAPPER_KINDS = new Set<ts.SyntaxKind>([
  SyntaxKind.ParenthesizedExpression,
  SyntaxKind.NonNullExpression,
  SyntaxKind.AsExpression,
  SyntaxKind.SatisfiesExpression,
  SyntaxKind.TypeAssertionExpression,
]);
const THIS_KINDS = new Set<ts.SyntaxKind>([
  SyntaxKind.ClassDeclaration,
  SyntaxKind.ClassExpression,
  SyntaxKind.FunctionDeclaration,
  SyntaxKind.FunctionExpression,
  SyntaxKind.MethodDeclaration,
  SyntaxKind.GetAccessor,
  SyntaxKind.SetAccessor,
]);
const FIRST_ASSIGNMENT = SyntaxKind.FirstAssignment;
const LAST_ASSIGNMENT = SyntaxKind.LastAssignment;
const IDENTIFIER = SyntaxKind.Identifier;
const THIS_KEYWORD = SyntaxKind.ThisKeyword;
const TYPE_QUERY = SyntaxKind.TypeQuery;
const EXPRESSION_WITH_TYPE_ARGUMENTS = SyntaxKind.ExpressionWithTypeArguments;
const IMPLEMENTS_KEYWORD = SyntaxKind.ImplementsKeyword;
const FUNCTION_DECLARATION = SyntaxKind.FunctionDeclaration;
const FUNCTION_EXPRESSION = SyntaxKind.FunctionExpression;
const CLASS_DECLARATION = SyntaxKind.ClassDeclaration;
const CLASS_EXPRESSION = SyntaxKind.ClassExpression;

function isIntrinsicTag(name: string): boolean {
  const first = name.charCodeAt(0);
  return (first >= 97 && first <= 122) || name.includes('-');
}

/** Identifiers that are names being declared or property names, not references. */
function isNonReference(id: ts.Identifier): boolean {
  const parent = id.parent;
  if (!parent) return true;
  if (NEVER_REFERENCES.has(parent.kind)) return true;
  if (isPropertyAccessExpression(parent)) return parent.name === id;
  if (isQualifiedName(parent)) return parent.right === id;
  if (isBindingElement(parent)) return parent.name === id || parent.propertyName === id;
  if (isLabeledStatement(parent) || isBreakOrContinueStatement(parent)) return parent.label === id;
  if (isTypePredicateNode(parent)) return parent.parameterName === id;
  if (isJsxOpeningElement(parent) || isJsxSelfClosingElement(parent)) return parent.tagName === id && isIntrinsicTag(id.text);
  return DECLARATION_KINDS.has(parent.kind) && (parent as ts.NamedDeclaration).name === id;
}

/** `x` in `x = value` (a write, not a reference). */
function isAssignmentTarget(node: ts.Node): boolean {
  const parent = node.parent;
  return (
    parent !== undefined &&
    isBinaryExpression(parent) &&
    parent.left === node &&
    parent.operatorToken.kind >= FIRST_ASSIGNMENT &&
    parent.operatorToken.kind <= LAST_ASSIGNMENT
  );
}

interface RefRecord {
  readonly from: number | null;
  readonly target: RefTarget;
  readonly kind: RefKind;
  readonly line: number;
  count: number;
}

class RefWalker {
  private readonly src: TsSource;
  private readonly ix: RefIndex;
  private readonly scopes: Scope[] = [];
  private readonly from: number[] = [];
  private readonly thisStack: Array<ReadonlyMap<string, number> | null> = [];
  private readonly records = new Map<string, RefRecord>();
  private inType = false;
  private inTypeQuery = false;
  private depth = 0;

  constructor(src: TsSource, ix: RefIndex) {
    this.src = src;
    this.ix = ix;
  }

  run(): ParsedRef[] {
    forEachChild(this.src.sf, this.visit);
    return [...this.records.values()].map((r) => ({ from: r.from, target: r.target, kind: r.kind, line: r.line, count: r.count }));
  }

  private readonly visit = (node: ts.Node): void => {
    if (this.depth >= MAX_WALK_DEPTH) return;
    const kind = node.kind;
    const symbol = this.ix.nodeToSymbol.get(node);
    if (symbol !== undefined) this.from.push(symbol);
    const scope = SCOPE_KINDS.has(kind) ? scopeFor(node, this.ix) : null;
    if (scope) this.scopes.push(scope);
    const thisPushed = THIS_KINDS.has(kind) && this.enterThis(node);
    const savedType = this.inType;
    const savedQuery = this.inTypeQuery;
    if (kind === TYPE_QUERY) {
      this.inType = true;
      this.inTypeQuery = true;
    } else if (!this.inType && kind !== EXPRESSION_WITH_TYPE_ARGUMENTS && isTypeNode(node)) {
      this.inType = true;
    }
    this.depth++;
    this.dispatch(node, kind);
    this.depth--;
    this.inType = savedType;
    this.inTypeQuery = savedQuery;
    if (thisPushed) this.thisStack.pop();
    if (scope) this.scopes.pop();
    if (symbol !== undefined) this.from.pop();
  };

  private dispatch(node: ts.Node, kind: ts.SyntaxKind): void {
    if (SKIPPED_SUBTREES.has(kind)) return;
    if (kind === IDENTIFIER) {
      this.identifier(node as ts.Identifier);
      return;
    }
    if (isPropertyAccessExpression(node) && this.memberAccess(node, node.expression, node.name.text, node.name)) return;
    if (
      isElementAccessExpression(node) &&
      isStaticString(node.argumentExpression) &&
      this.memberAccess(node, node.expression, node.argumentExpression.text, node.argumentExpression)
    ) {
      return;
    }
    if (isQualifiedName(node) && this.qualifiedName(node)) return;
    if (isImportTypeNode(node)) {
      this.importType(node);
      return;
    }
    forEachChild(node, this.visit);
  }

  private enterThis(node: ts.Node): boolean {
    const kind = node.kind;
    let key: ts.Node;
    if (kind === CLASS_DECLARATION || kind === CLASS_EXPRESSION || kind === FUNCTION_DECLARATION || kind === FUNCTION_EXPRESSION) {
      key = node;
    } else if (isObjectLiteralExpression(node.parent)) {
      key = node.parent;
    } else {
      return false;
    }
    this.thisStack.push(this.ix.thisMaps.get(key) ?? null);
    return true;
  }

  private kindOf(node: ts.Node): RefKind {
    let current = node;
    let parent = current.parent;
    while (parent && WRAPPER_KINDS.has(parent.kind) && (parent as ts.ParenthesizedExpression).expression === current) {
      current = parent;
      parent = parent.parent;
    }
    if (parent) {
      if ((isCallExpression(parent) || isNewExpression(parent)) && parent.expression === current) return 'calls';
      if (isTaggedTemplateExpression(parent) && parent.tag === current) return 'calls';
      if (isDecorator(parent)) return 'calls';
      if ((isJsxOpeningElement(parent) || isJsxSelfClosingElement(parent)) && parent.tagName === current) return 'renders';
      if (isExpressionWithTypeArguments(parent) && parent.expression === current && isHeritageClause(parent.parent)) {
        return parent.parent.token === IMPLEMENTS_KEYWORD ? 'implements' : 'extends';
      }
    }
    return this.inType ? 'uses-type' : 'references';
  }

  private meaningOf(node: ts.Node, kind: RefKind): number {
    if (kind === 'implements') return TYPE;
    if (kind === 'extends') return isInterfaceDeclaration(node.parent?.parent?.parent ?? node) ? TYPE : VALUE;
    return this.inType && !this.inTypeQuery ? TYPE : VALUE;
  }

  private resolve(name: string, meaning: number): RefTarget | null {
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      const binding = this.scopes[i]?.get(name);
      if (!binding) continue;
      if (binding.kind === 'shadow') {
        if ((binding.meaning & meaning) !== 0) return null;
        continue;
      }
      if (binding.kind === 'import') return { type: 'import', importIndex: binding.ref.importIndex, name: binding.ref.imported };
      return { type: 'local', symbol: binding.symbol };
    }
    const imported = this.ix.moduleImports.get(name);
    if (imported) return { type: 'import', importIndex: imported.importIndex, name: imported.imported };
    const preferred = meaning === TYPE ? this.ix.typeNames : this.ix.valueNames;
    const fallback = meaning === TYPE ? this.ix.valueNames : this.ix.typeNames;
    const symbol = preferred.get(name) ?? fallback.get(name);
    return symbol === undefined ? null : { type: 'local', symbol };
  }

  private identifier(id: ts.Identifier): void {
    if (id.text === '' || isNonReference(id)) return;
    const kind = this.kindOf(id);
    const target = this.resolve(id.text, this.meaningOf(id, kind));
    if (target) this.emit(target, kind, id);
  }

  /** True when `name` is declared by any enclosing local scope. */
  private isLocal(name: string): boolean {
    return this.scopes.some((scope) => scope.has(name));
  }

  /** `exports` or `module.exports` used as an object (not shadowed by a local binding). */
  private isExportsObject(object: ts.Expression): boolean {
    if (isIdentifier(object)) return object.text === 'exports' && !this.isLocal('exports');
    return (
      isPropertyAccessExpression(object) &&
      object.name.text === 'exports' &&
      isIdentifier(object.expression) &&
      object.expression.text === 'module' &&
      !this.isLocal('module')
    );
  }

  /** `ns.foo`, `this.m`, `Local.member`, `exports.x`: returns true when handled (children are then skipped). */
  private memberAccess(node: ts.Expression, object: ts.Expression, name: string, at: ts.Node): boolean {
    if (object.kind === THIS_KEYWORD) {
      const map = this.thisStack[this.thisStack.length - 1] ?? null;
      const member = map?.get(name);
      if (member !== undefined) this.emit({ type: 'local', symbol: member }, this.kindOf(node), at);
      return true;
    }
    if (this.ix.cjsExports.size > 0 && this.isExportsObject(object)) {
      const exported = this.ix.cjsExports.get(name);
      if (exported !== undefined && !isAssignmentTarget(node)) this.emit({ type: 'local', symbol: exported }, this.kindOf(node), at);
      return true;
    }
    if (!isIdentifier(object) || isNonReference(object)) return false;
    return this.memberOf(object.text, name, this.kindOf(node), at, this.inType && !this.inTypeQuery ? TYPE : VALUE);
  }

  private memberOf(objectName: string, member: string, kind: RefKind, at: ts.Node, meaning: number): boolean {
    const target = this.resolve(objectName, meaning);
    if (target?.type === 'import' && target.name === '*') {
      this.emit({ type: 'import', importIndex: target.importIndex, name: member }, kind, at);
      return true;
    }
    if (target?.type === 'local') {
      const index = this.ix.members.get(target.symbol)?.get(member);
      if (index !== undefined) {
        this.emit({ type: 'local', symbol: index }, kind, at);
        return true;
      }
    }
    return false;
  }

  private qualifiedName(node: ts.QualifiedName): boolean {
    if (!isIdentifier(node.left)) return false;
    return this.memberOf(node.left.text, node.right.text, this.kindOf(node), node.right, this.inTypeQuery ? VALUE : TYPE);
  }

  private importType(node: ts.ImportTypeNode): void {
    const importIndex = this.ix.nodeToImport.get(node);
    const imported = importIndex === undefined ? undefined : this.ix.imports[importIndex]?.bindings[0]?.imported;
    if (importIndex !== undefined && imported !== undefined) {
      this.emit({ type: 'import', importIndex, name: imported }, 'uses-type', node);
    }
    for (const arg of node.typeArguments ?? []) this.visit(arg);
  }

  private emit(target: RefTarget, kind: RefKind, at: ts.Node): void {
    const from = this.from.length > 0 ? (this.from[this.from.length - 1] ?? null) : null;
    const targetKey = target.type === 'local' ? `L${target.symbol}` : `I${target.importIndex}:${target.name}`;
    const key = `${from ?? '-'}|${targetKey}|${kind}`;
    const existing = this.records.get(key);
    if (existing) {
      existing.count += 1;
      return;
    }
    this.records.set(key, { from, target, kind, line: this.src.line(at.getStart(this.src.sf)), count: 1 });
  }
}

/** Collect merged references for the whole file. */
export function collectRefs(src: TsSource, ix: RefIndex): ParsedRef[] {
  return new RefWalker(src, ix).run();
}
