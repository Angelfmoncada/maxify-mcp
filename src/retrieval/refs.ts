import { MaxifyError } from '../core/errors.js';

export type EvidenceRef =
  | { type: 'blob'; hash: string }
  | { type: 'range'; path: string; start: number; end: number }
  | { type: 'symbol'; path: string; qual: string }
  | { type: 'file'; path: string }
  | { type: 'name'; name: string };

const FILE_LIKE = /[/\\]|\.[A-Za-z0-9]{1,8}$/;

/**
 * Parse refs accepted by maxify_source / maxify_impact / maxify_memory:
 * 'blob:HASH', 'path:START-END', 'path:LINE', 'path#L10-L20', 'path#Qual.Name',
 * '#Name' or 'Name', and plain 'path'.
 */
export function parseRef(input: string): EvidenceRef {
  const ref = input.trim().replace(/^[`'"]+|[`'"]+$/g, '');
  if (ref.length === 0 || ref.length > 1000) throw new MaxifyError('INVALID_INPUT', 'ref is empty or too long');
  const blob = /^blob:([0-9a-f]{8,64})$/i.exec(ref);
  if (blob?.[1]) return { type: 'blob', hash: blob[1].toLowerCase() };
  const hashIndex = ref.indexOf('#');
  if (hashIndex >= 0) {
    const path = ref.slice(0, hashIndex);
    const rest = ref.slice(hashIndex + 1);
    const lines = /^L(\d+)(?:-L?(\d+))?$/.exec(rest);
    if (path.length > 0 && lines?.[1]) return range(path, Number(lines[1]), Number(lines[2] ?? lines[1]));
    if (rest.length === 0) throw new MaxifyError('INVALID_INPUT', `ref "${input}" has an empty symbol after '#'`);
    return path.length > 0 ? { type: 'symbol', path, qual: rest } : { type: 'name', name: rest };
  }
  const lineRef = /^(.+?):(\d+)(?:-(\d+))?$/.exec(ref);
  if (lineRef?.[1] && lineRef[2] && FILE_LIKE.test(lineRef[1])) {
    return range(lineRef[1], Number(lineRef[2]), Number(lineRef[3] ?? lineRef[2]));
  }
  if (FILE_LIKE.test(ref)) return { type: 'file', path: ref };
  return { type: 'name', name: ref };
}

function range(path: string, start: number, end: number): EvidenceRef {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) {
    throw new MaxifyError('INVALID_INPUT', `invalid line range ${start}-${end} (1-based, START <= END)`);
  }
  return { type: 'range', path, start, end };
}

/** Parse 'START-END' (or 'LINE') for blob line selection. */
export function parseLineRange(spec: string): { start: number; end: number } {
  const m = /^\s*(\d+)\s*(?:-\s*(\d+))?\s*$/.exec(spec);
  if (!m?.[1]) throw new MaxifyError('INVALID_INPUT', `lines must look like "START-END", got "${spec}"`);
  const start = Number(m[1]);
  const end = Number(m[2] ?? m[1]);
  if (start < 1 || end < start) throw new MaxifyError('INVALID_INPUT', `invalid line range ${spec}`);
  return { start, end };
}
