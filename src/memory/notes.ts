import { MaxifyError } from '../core/errors.js';
import { sha256 } from '../core/hash.js';
import type { RepoGuard } from '../core/paths.js';
import type { MemoryRequest } from '../engine/types.js';
import { analyzeTask, ftsOr } from '../retrieval/query.js';
import { parseRef } from '../retrieval/refs.js';
import type { NoteView } from '../retrieval/render.js';
import type { AuxStore, NoteRef, NoteRow } from '../store/aux-store.js';
import type { IndexStore } from '../store/index-store.js';

export const MAX_NOTE_CHARS = 1000;
const MAX_REFS = 10;

export interface MemoryDeps {
  aux: AuxStore;
  store: IndexStore;
  guard: RepoGuard;
  now: () => number;
}

const STATUS_NOTE =
  'status = whether the referenced code changed since the note was written (Maxify checks references, not the claim itself).';

function anchor(deps: MemoryDeps, raw: string): NoteRef {
  const ref = parseRef(raw);
  if (ref.type === 'blob' || ref.type === 'name') {
    throw new MaxifyError('INVALID_INPUT', `note refs must be 'path' or 'path#Symbol' (got "${raw}")`);
  }
  const path = deps.guard.resolve(ref.path);
  const file = deps.store.fileByPath(path);
  if (!file) throw new MaxifyError('NOT_FOUND', `${path} is not in the index; notes can only reference indexed files.`);
  if (ref.type === 'symbol') {
    const symbols = deps.store.symbolsOfFile(file.id);
    const symbol = symbols.find((s) => s.qualName === ref.qual) ?? symbols.find((s) => s.name === ref.qual);
    if (!symbol) throw new MaxifyError('NOT_FOUND', `No symbol "${ref.qual}" in ${path}.`);
    return { ref: `${path}#${symbol.qualName}`, path, symbol: symbol.qualName, hash: file.hash };
  }
  return { ref: path, path, hash: file.hash };
}

function refStatus(deps: MemoryDeps, ref: NoteRef): string {
  const file = deps.store.fileByPath(ref.path);
  if (!file) return `${ref.ref} missing`;
  if (ref.symbol && !deps.store.symbolsOfFile(file.id).some((s) => s.qualName === ref.symbol)) return `${ref.ref} symbol missing`;
  if (file.hash !== ref.hash) return `${ref.path} changed`;
  return '';
}

export function noteStatus(deps: MemoryDeps, note: NoteRow): string {
  if (note.refs.length === 0) return 'unanchored';
  const problems = note.refs.map((r) => refStatus(deps, r)).filter((p) => p.length > 0);
  return problems.length === 0 ? 'current' : `STALE (${problems.join('; ')})`;
}

export function toView(deps: MemoryDeps, note: NoteRow): NoteView {
  return {
    id: note.id,
    kind: note.kind,
    origin: note.origin,
    date: new Date(note.updatedAt).toISOString().slice(0, 10),
    status: noteStatus(deps, note),
    text: note.text,
    refs: note.refs.map((r) => r.ref),
  };
}

function line(view: NoteView): string {
  const refs = view.refs.length > 0 ? ` (refs: ${view.refs.join(', ')})` : '';
  return `- ${view.id} · ${view.kind} · ${view.origin} · ${view.date} · ${view.status}: ${view.text}${refs}`;
}

function validateText(text: string | undefined): string {
  const value = (text ?? '').trim();
  if (value.length === 0) throw new MaxifyError('INVALID_INPUT', 'note text is required');
  if (value.length > MAX_NOTE_CHARS) throw new MaxifyError('INVALID_INPUT', `note text exceeds ${MAX_NOTE_CHARS} characters; keep notes small`);
  return value;
}

function anchorAll(deps: MemoryDeps, refs: readonly string[] | undefined): NoteRef[] {
  const list = refs ?? [];
  if (list.length > MAX_REFS) throw new MaxifyError('INVALID_INPUT', `at most ${MAX_REFS} refs per note`);
  return list.map((r) => anchor(deps, r));
}

function requireNote(deps: MemoryDeps, id: string | undefined): NoteRow {
  if (!id) throw new MaxifyError('INVALID_INPUT', 'id is required');
  const note = deps.aux.getNote(id);
  if (!note) throw new MaxifyError('NOT_FOUND', `No note with id ${id}.`);
  return note;
}

function searchNotes(deps: MemoryDeps, query: string, limit: number): NoteRow[] {
  const terms = analyzeTask(query).terms;
  const byText = terms.length > 0 ? safeSearch(deps, ftsOr(terms), limit) : [];
  const lowered = query.toLowerCase();
  const byRef = deps.aux.allNotes().filter((n) => n.refs.some((r) => r.ref.toLowerCase().includes(lowered)));
  const seen = new Set<string>();
  return [...byRef, ...byText].filter((n) => (seen.has(n.id) ? false : (seen.add(n.id), true))).slice(0, limit);
}

function safeSearch(deps: MemoryDeps, match: string, limit: number): NoteRow[] {
  try {
    return deps.aux.searchNotes(match, limit);
  } catch {
    return [];
  }
}

/** Explicit note operations. Notes are claims by the agent or user, never presented as verified source. */
export function memoryOp(deps: MemoryDeps, req: MemoryRequest): string {
  const limit = Math.max(1, Math.min(50, req.limit ?? 10));
  switch (req.op) {
    case 'add': {
      const text = validateText(req.text);
      const now = deps.now();
      const note: NoteRow = {
        id: `n${sha256(`${text}|${now}|${Math.random()}`).slice(0, 7)}`,
        text,
        kind: req.kind ?? 'note',
        origin: req.origin ?? 'agent',
        refs: anchorAll(deps, req.refs),
        createdAt: now,
        updatedAt: now,
      };
      deps.aux.putNote(note);
      return `maxify_memory · added\n${line(toView(deps, note))}`;
    }
    case 'update': {
      const note = requireNote(deps, req.id);
      const updated: NoteRow = {
        ...note,
        text: req.text === undefined ? note.text : validateText(req.text),
        kind: req.kind ?? note.kind,
        origin: req.origin ?? note.origin,
        refs: req.refs === undefined ? note.refs.map((r) => anchor(deps, r.ref)) : anchorAll(deps, req.refs),
        updatedAt: deps.now(),
      };
      deps.aux.putNote(updated);
      return `maxify_memory · updated (refs re-anchored to current code)\n${line(toView(deps, updated))}`;
    }
    case 'delete': {
      const id = requireNote(deps, req.id).id;
      deps.aux.deleteNote(id);
      return `maxify_memory · deleted ${id}`;
    }
    case 'get':
      return `maxify_memory · ${STATUS_NOTE}\n${line(toView(deps, requireNote(deps, req.id)))}`;
    case 'search': {
      if (!req.query) throw new MaxifyError('INVALID_INPUT', 'query is required for search');
      const found = searchNotes(deps, req.query, limit);
      if (found.length === 0) return `maxify_memory · no notes match "${req.query}"`;
      return [`maxify_memory · ${found.length} notes · ${STATUS_NOTE}`, ...found.map((n) => line(toView(deps, n)))].join('\n');
    }
    case 'list': {
      const notes = deps.aux.listNotes(limit);
      if (notes.length === 0) return 'maxify_memory · no notes yet';
      return [`maxify_memory · ${notes.length} of ${deps.aux.countNotes()} notes · ${STATUS_NOTE}`, ...notes.map((n) => line(toView(deps, n)))].join('\n');
    }
  }
}

/** Notes relevant to a context request: anchored to the given paths first, then text matches. */
export function notesFor(deps: MemoryDeps, paths: readonly string[], task: string, limit: number): NoteView[] {
  const pathSet = new Set(paths);
  const anchored = deps.aux.allNotes().filter((n) => n.refs.some((r) => pathSet.has(r.path)));
  const terms = analyzeTask(task).terms;
  const matched = terms.length > 0 ? safeSearch(deps, ftsOr(terms), limit) : [];
  const seen = new Set<string>();
  const out: NoteView[] = [];
  for (const note of [...anchored, ...matched]) {
    if (seen.has(note.id) || out.length >= limit) continue;
    seen.add(note.id);
    out.push(toView(deps, note));
  }
  return out;
}

/** Follow a detected rename: move note refs from oldPath to newPath (content hash is unchanged). */
export function migrateNoteRefs(aux: AuxStore, oldPath: string, newPath: string, now: number): number {
  let moved = 0;
  for (const note of aux.allNotes()) {
    if (!note.refs.some((r) => r.path === oldPath)) continue;
    const refs = note.refs.map((r) =>
      r.path === oldPath ? { ...r, path: newPath, ref: r.symbol ? `${newPath}#${r.symbol}` : newPath } : r,
    );
    aux.putNote({ ...note, refs, updatedAt: now });
    moved++;
  }
  return moved;
}
