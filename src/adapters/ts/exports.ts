/**
 * Export statements that name local bindings: `export { a, b as c }`,
 * `export default a`, `export = a`, `module.exports = a`,
 * `module.exports = { a, b: c }`, `exports.x = a`. Names bound to local
 * declarations mark those symbols exported; names bound to imports become
 * explicit 're-export' records (the file re-exports what it imported).
 */
import ts from 'typescript';
import type { ImportBinding } from '../../core/types.js';
import { cjsAssignment, type CjsAssignment } from './cjs.js';
import type { SymbolDraft } from './drafts.js';
import type { ImportDraft } from './imports.js';
import { propertyNameText, unwrapExpression, type TsSource } from './source.js';

export interface ExportMark {
  readonly names: readonly string[];
  readonly flags: readonly string[];
}

export interface ExportPass {
  readonly marks: ReadonlyMap<SymbolDraft, ExportMark>;
  /** Re-exports of imported bindings (`import { a } from 'm'; export { a }`). */
  readonly reexports: readonly ImportDraft[];
}

interface ImportedBinding {
  readonly draft: ImportDraft;
  readonly binding: ImportBinding;
}

type Exporter = (local: string, exported: string, flags: readonly string[], typeOnly: boolean) => void;

function topLevelBindings(drafts: readonly SymbolDraft[]): Map<string, SymbolDraft[]> {
  const byName = new Map<string, SymbolDraft[]>();
  for (const draft of drafts) {
    if (draft.parent !== null || !draft.binds) continue;
    byName.set(draft.name, [...(byName.get(draft.name) ?? []), draft]);
  }
  return byName;
}

function importedBindings(imports: readonly ImportDraft[]): Map<string, ImportedBinding> {
  const byLocal = new Map<string, ImportedBinding>();
  for (const draft of imports) {
    if (!draft.topLevel || draft.kind === 'reexport' || draft.kind === 'reexport-all') continue;
    for (const binding of draft.bindings) {
      if (binding.local !== '' && !byLocal.has(binding.local)) byLocal.set(binding.local, { draft, binding });
    }
  }
  return byLocal;
}

function cjsExports(src: TsSource, assignment: CjsAssignment, exportName: Exporter): void {
  const value = unwrapExpression(assignment.value);
  for (const target of assignment.targets) {
    if (target.kind === 'named') {
      if (ts.isIdentifier(value)) exportName(value.text, target.name, ['commonjs'], false);
      continue;
    }
    if (ts.isIdentifier(value)) {
      exportName(value.text, 'default', ['commonjs'], false);
    } else if (ts.isObjectLiteralExpression(value)) {
      for (const member of value.properties) {
        if (ts.isShorthandPropertyAssignment(member)) {
          exportName(member.name.text, member.name.text, ['commonjs'], false);
        } else if (ts.isPropertyAssignment(member)) {
          const init = unwrapExpression(member.initializer);
          if (ts.isIdentifier(init)) exportName(init.text, propertyNameText(src, member.name), ['commonjs'], false);
        }
      }
    }
  }
}

function statementExports(src: TsSource, stmt: ts.Statement, exportName: Exporter): void {
  if (ts.isExportDeclaration(stmt)) {
    const clause = stmt.exportClause;
    if (stmt.moduleSpecifier || !clause || !ts.isNamedExports(clause)) return;
    for (const el of clause.elements) {
      exportName((el.propertyName ?? el.name).text, el.name.text, [], stmt.isTypeOnly || el.isTypeOnly);
    }
    return;
  }
  if (ts.isExportAssignment(stmt)) {
    const value = unwrapExpression(stmt.expression);
    if (ts.isIdentifier(value)) exportName(value.text, 'default', stmt.isExportEquals ? ['export-equals'] : [], false);
    return;
  }
  const assignment = cjsAssignment(stmt, src.sf);
  if (assignment) cjsExports(src, assignment, exportName);
}

/** Resolve by-name export statements against local declarations and imports. */
export function collectExports(src: TsSource, drafts: readonly SymbolDraft[], imports: readonly ImportDraft[]): ExportPass {
  const locals = topLevelBindings(drafts);
  const imported = importedBindings(imports);
  const marks = new Map<SymbolDraft, ExportMark>();
  const reexports: ImportDraft[] = [];
  for (const stmt of src.sf.statements) {
    const pending = new Map<ImportDraft, ImportBinding[]>();
    statementExports(src, stmt, (local, exported, flags, typeOnly) => {
      const targets = locals.get(local);
      if (targets) {
        for (const target of targets) {
          const previous = marks.get(target);
          marks.set(target, {
            names: [...(previous?.names ?? []), exported],
            flags: [...(previous?.flags ?? []), ...flags],
          });
        }
        return;
      }
      const source = imported.get(local);
      if (!source) return;
      const binding = { imported: source.binding.imported, local: exported, typeOnly: typeOnly || source.binding.typeOnly };
      pending.set(source.draft, [...(pending.get(source.draft) ?? []), binding]);
    });
    const pos = stmt.getStart(src.sf);
    for (const [draft, bindings] of pending) {
      reexports.push({ pos, spec: draft.spec, kind: 'reexport', bindings, line: src.line(pos), node: null, topLevel: false });
    }
  }
  return { marks, reexports };
}
