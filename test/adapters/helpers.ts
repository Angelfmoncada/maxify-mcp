import type { ParsedFile, ParsedImport, ParsedRef, ParsedSymbol, RefKind } from '../../src/core/types.js';
import { typescriptAdapter } from '../../src/adapters/typescript.js';

/** Join source lines with '\n' so line numbers in tests are explicit. */
export function src(...lines: string[]): string {
  return lines.join('\n');
}

export function parseTs(source: string, relPath = 'src/sample.ts'): ParsedFile {
  return typescriptAdapter.parse(relPath, source);
}

export function symbolIndex(file: ParsedFile, qualName: string): number {
  const index = file.symbols.findIndex((s) => s.qualName === qualName);
  if (index === -1) {
    throw new Error(`no symbol "${qualName}"; have: ${file.symbols.map((s) => s.qualName).join(', ')}`);
  }
  return index;
}

export function sym(file: ParsedFile, qualName: string): ParsedSymbol {
  const found = file.symbols[symbolIndex(file, qualName)];
  if (!found) throw new Error(`no symbol "${qualName}"`);
  return found;
}

export function qualNames(file: ParsedFile): string[] {
  return file.symbols.map((s) => s.qualName);
}

export function importOf(file: ParsedFile, spec: string, kind?: ParsedImport['kind']): ParsedImport {
  const found = file.imports.find((i) => i.spec === spec && (kind === undefined || i.kind === kind));
  if (!found) throw new Error(`no import "${spec}"; have: ${file.imports.map((i) => `${i.kind}:${i.spec}`).join(', ')}`);
  return found;
}

/** Human-readable rendering of refs: 'from -> target [kind] xN'. */
export function describeRefs(file: ParsedFile): string[] {
  const nameOf = (index: number | null): string => (index === null ? '<module>' : (file.symbols[index]?.qualName ?? `#${index}`));
  return file.refs.map((ref: ParsedRef) => {
    const target =
      ref.target.type === 'local'
        ? nameOf(ref.target.symbol)
        : `${file.imports[ref.target.importIndex]?.spec ?? '?'}#${ref.target.name}`;
    return `${nameOf(ref.from)} -> ${target} [${ref.kind}]${ref.count > 1 ? ` x${ref.count}` : ''}`;
  });
}

export function refsOfKind(file: ParsedFile, kind: RefKind): string[] {
  return describeRefs(file).filter((line) => line.includes(`[${kind}]`));
}
