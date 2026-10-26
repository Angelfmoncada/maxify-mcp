import { fence, langForPath } from '../core/fence.js';
import type { DetailLevel } from '../engine/types.js';
import type { FileRow } from '../store/rows.js';
import type { Uncertainty } from './graph.js';
import { itemRef, type Item, type RelationNote } from './items.js';
import type { Level } from './plan.js';

/** Fresh view of a file read from disk for rendering (lines without '\r'). */
export interface FileView {
  hash: string;
  lines: string[];
  crlf: boolean;
}

export interface NoteView {
  id: string;
  kind: string;
  origin: string;
  date: string;
  status: string;
  text: string;
  refs: string[];
}

export interface RenderInput {
  title: string;
  task: string;
  generation: number;
  budget: number;
  items: readonly Item[];
  levels: ReadonlyMap<string, Level>;
  covered: ReadonlySet<string>;
  uncertain: readonly Uncertainty[];
  notes: readonly NoteView[];
  omitted: readonly Item[];
  complete: boolean;
  cursor?: string;
  /** Refs (path#Qual) whose exact source was already sent this session, unchanged (delta mode only). */
  sentBefore?: ReadonlySet<string>;
  view: (file: FileRow) => FileView;
  /** Estimated source tokens of an omitted item (for the omitted list). */
  sourceTokens: (item: Item) => number;
}

const TAG: Record<DetailLevel, string> = { source: 'src', signature: 'sig', map: 'map' };
export const LEGEND =
  'legend: [src] exact current source · [sig] derived signature, not source · [map] location only · cross-file links say resolved (static import resolution) or heuristic (naming convention)';

function shortHash(hash: string): string {
  return hash.slice(0, 10);
}

function displayName(item: Item): string {
  const s = item.node?.symbol;
  if (!s) return '';
  return s.kind === 'test' || s.kind === 'suite' ? `"${s.qualName}"` : s.qualName;
}

function relationText(item: Item, dir: 'in' | 'out'): string {
  const list = item.relations.filter((r) => r.dir === dir);
  if (list.length === 0) return '';
  const shown = list.slice(0, 3).map((r) => describeRelation(item, r));
  const more = list.length > 3 ? ` +${list.length - 3} more` : '';
  return ` · ${dir === 'in' ? '←' : '→'} ${shown.join(', ')}${more}`;
}

function describeRelation(item: Item, r: RelationNote): string {
  const crossFile = !r.label.includes(`(${item.file.path}:`);
  const tag = r.provenance === 'extracted' && !crossFile ? '' : ` ${r.provenance}`;
  return `${r.label}${tag}`;
}

export function itemLine(item: Item, level: DetailLevel): string {
  const s = item.node?.symbol;
  if (!s) return `[map] whole file${relationText(item, 'out')}${relationText(item, 'in')}`;
  const exported = s.exported ? ' · exported' : '';
  return `L${s.startLine}-${s.endLine} ${s.kind} ${displayName(item)}${exported} [${TAG[level]}]${relationText(item, 'in')}${relationText(item, 'out')}`;
}

export function itemBlock(item: Item, level: DetailLevel, view: FileView | null, sentBefore?: ReadonlySet<string>): string {
  const line = itemLine(item, level);
  const s = item.node?.symbol;
  if (!s || level === 'map') return line;
  if (level === 'signature') {
    const sig = s.signature.trim();
    if (sig.length === 0) return line;
    return `${line}\n${sig.split('\n').map((l) => `  ${l}`).join('\n')}`;
  }
  if (sentBefore?.has(itemRef(item)) && view) {
    return `${line}\n  (exact source already sent this session, file unchanged at h:${shortHash(view.hash)}; if it is no longer in your context: maxify_source ref=${itemRef(item)})`;
  }
  const text = view ? view.lines.slice(s.startLine - 1, s.endLine).join('\n') : '';
  return `${line}\n${fence(text, langForPath(item.file.path))}`;
}

export function fileHeader(file: FileRow, view: FileView | null): string {
  const lines = view ? view.lines.length : file.lineCount;
  const flags = [view?.crlf ? 'CRLF' : '', file.isTest ? 'test' : ''].filter((f) => f.length > 0);
  return `## ${file.path} · h:${shortHash(view?.hash ?? file.hash)} · ${lines} lines${flags.length > 0 ? ` · ${flags.join(' · ')}` : ''}`;
}

function fileOrder(items: readonly Item[], visible: (i: Item) => boolean): FileRow[] {
  const best = new Map<number, { file: FileRow; score: number }>();
  for (const item of items) {
    if (!visible(item)) continue;
    const prev = best.get(item.file.id);
    if (!prev || item.score > prev.score) best.set(item.file.id, { file: item.file, score: item.score });
  }
  return [...best.values()]
    .sort((a, b) => b.score - a.score || (a.file.path < b.file.path ? -1 : 1))
    .map((v) => v.file);
}

function renderOmitted(input: RenderInput): string[] {
  if (input.omitted.length === 0 && !input.cursor) return [];
  const out = ['## omitted — expand with maxify_source ref=<ref>'];
  for (const item of input.omitted.slice(0, 8)) {
    const level = input.levels.get(item.key) ?? 'omitted';
    const shown = level === 'omitted' ? '' : ` (${TAG[level as DetailLevel]} shown)`;
    const kind = item.node ? item.node.symbol.kind : 'file';
    out.push(`- ${itemRef(item)} · ${kind} · ~${input.sourceTokens(item)} tok as source${shown}`);
  }
  if (input.omitted.length > 8) out.push(`- +${input.omitted.length - 8} more`);
  if (input.cursor) out.push(`- next page: maxify_context cursor=${input.cursor}`);
  return out;
}

function renderUncertain(list: readonly Uncertainty[]): string[] {
  if (list.length === 0) return [];
  const out = ['## uncertain — not linked by static analysis'];
  for (const u of list.slice(0, 8)) out.push(`- ${u.path}:${u.line} ${u.kind}: ${u.detail}`);
  if (list.length > 8) out.push(`- +${list.length - 8} more (maxify_stats scope=index)`);
  return out;
}

function renderNotes(notes: readonly NoteView[]): string[] {
  if (notes.length === 0) return [];
  const out = ['## notes — agent/user-authored, not verified source'];
  for (const n of notes) {
    const refs = n.refs.length > 0 ? ` (refs: ${n.refs.join(', ')})` : '';
    out.push(`- ${n.id} · ${n.kind} · ${n.origin} · ${n.date} · ${n.status}: ${n.text}${refs}`);
  }
  return out;
}

/** Render the final context package. Placeholder `{{EST}}` in the header is filled by the caller. */
export function renderContext(input: RenderInput): string {
  const visible = (i: Item): boolean => (input.levels.get(i.key) ?? 'omitted') !== 'omitted' && !input.covered.has(i.key);
  const status = input.complete ? 'complete' : 'INCOMPLETE — see omitted';
  const task = input.task.replace(/\s+/g, ' ').trim();
  const parts: string[] = [
    `${input.title} · gen ${input.generation} · est. {{EST}}/${input.budget} tokens · ${status}`,
    `task: ${task.length > 200 ? `${task.slice(0, 200)}…` : task}`,
    LEGEND,
  ];
  for (const file of fileOrder(input.items, visible)) {
    const view = file.status === 'indexed' ? input.view(file) : null;
    const fileItems = input.items
      .filter((i) => i.file.id === file.id && visible(i))
      .sort((a, b) => (a.node?.symbol.startLine ?? 0) - (b.node?.symbol.startLine ?? 0));
    parts.push('');
    parts.push(fileHeader(file, view));
    for (const item of fileItems) {
      const level = input.levels.get(item.key) as DetailLevel;
      parts.push(itemBlock(item, level, view, input.sentBefore));
    }
  }
  for (const section of [renderUncertain(input.uncertain), renderNotes(input.notes), renderOmitted(input)]) {
    if (section.length > 0) parts.push('', ...section);
  }
  return parts.join('\n');
}
