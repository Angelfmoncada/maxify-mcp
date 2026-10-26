import type { ImportBinding, ImportKind, RefKind, SymbolKind, UnresolvedKind } from '../core/types.js';
import type { Resolution } from '../indexer/resolve.js';
import type { Row } from './db.js';

export type FileStatus = 'indexed' | 'noise' | 'unsupported' | 'too_large' | 'binary' | 'secret' | 'error';

export interface FileRow {
  id: number;
  path: string;
  hash: string;
  size: number;
  mtimeMs: number;
  language: string;
  status: FileStatus;
  isTest: boolean;
  lineCount: number;
  adapter: string;
  generation: number;
  error: string | null;
}

export interface SymbolRow {
  id: number;
  fileId: number;
  ordinal: number;
  name: string;
  qualName: string;
  kind: SymbolKind;
  startLine: number;
  endLine: number;
  exported: boolean;
  exportNames: string[];
  signature: string;
  doc: string;
  parentOrdinal: number | null;
  flags: string[];
}

export interface ImportRow {
  id: number;
  fileId: number;
  ordinal: number;
  spec: string;
  kind: ImportKind;
  bindings: ImportBinding[];
  line: number;
  resolvedPath: string | null;
  resolution: Resolution | 'pending';
}

export interface RefRow {
  id: number;
  fileId: number;
  fromOrdinal: number | null;
  targetType: 'local' | 'import';
  targetOrdinal: number;
  targetName: string | null;
  kind: RefKind;
  line: number;
  count: number;
}

export interface UnresolvedRow {
  fileId: number;
  line: number;
  kind: UnresolvedKind;
  detail: string;
}

const str = (row: Row, key: string): string => String(row[key] ?? '');
const num = (row: Row, key: string): number => Number(row[key] ?? 0);
const nullableNum = (row: Row, key: string): number | null => (row[key] === null || row[key] === undefined ? null : Number(row[key]));

function jsonArray<T>(value: unknown): T[] {
  if (typeof value !== 'string' || value.length === 0) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

export function toFileRow(row: Row): FileRow {
  return {
    id: num(row, 'id'),
    path: str(row, 'path'),
    hash: str(row, 'hash'),
    size: num(row, 'size'),
    mtimeMs: num(row, 'mtime_ms'),
    language: str(row, 'language'),
    status: str(row, 'status') as FileStatus,
    isTest: num(row, 'is_test') === 1,
    lineCount: num(row, 'line_count'),
    adapter: str(row, 'adapter'),
    generation: num(row, 'generation'),
    error: row.error === null || row.error === undefined ? null : String(row.error),
  };
}

export function toSymbolRow(row: Row): SymbolRow {
  return {
    id: num(row, 'id'),
    fileId: num(row, 'file_id'),
    ordinal: num(row, 'ordinal'),
    name: str(row, 'name'),
    qualName: str(row, 'qual_name'),
    kind: str(row, 'kind') as SymbolKind,
    startLine: num(row, 'start_line'),
    endLine: num(row, 'end_line'),
    exported: num(row, 'exported') === 1,
    exportNames: jsonArray<string>(row.export_names),
    signature: str(row, 'signature'),
    doc: str(row, 'doc'),
    parentOrdinal: nullableNum(row, 'parent_ordinal'),
    flags: jsonArray<string>(row.flags),
  };
}

export function toImportRow(row: Row): ImportRow {
  return {
    id: num(row, 'id'),
    fileId: num(row, 'file_id'),
    ordinal: num(row, 'ordinal'),
    spec: str(row, 'spec'),
    kind: str(row, 'kind') as ImportKind,
    bindings: jsonArray<ImportBinding>(row.bindings),
    line: num(row, 'line'),
    resolvedPath: row.resolved_path === null || row.resolved_path === undefined ? null : String(row.resolved_path),
    resolution: str(row, 'resolution') as Resolution | 'pending',
  };
}

export function toRefRow(row: Row): RefRow {
  return {
    id: num(row, 'id'),
    fileId: num(row, 'file_id'),
    fromOrdinal: nullableNum(row, 'from_ordinal'),
    targetType: str(row, 'target_type') as 'local' | 'import',
    targetOrdinal: num(row, 'target_ordinal'),
    targetName: row.target_name === null || row.target_name === undefined ? null : String(row.target_name),
    kind: str(row, 'kind') as RefKind,
    line: num(row, 'line'),
    count: num(row, 'count'),
  };
}

export function toUnresolvedRow(row: Row): UnresolvedRow {
  return {
    fileId: num(row, 'file_id'),
    line: num(row, 'line'),
    kind: str(row, 'kind') as UnresolvedKind,
    detail: str(row, 'detail'),
  };
}
