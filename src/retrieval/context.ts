import { estimateTokens } from '../core/tokens.js';
import type { RepoGuard } from '../core/paths.js';
import { MaxifyError } from '../core/errors.js';
import { MAX_RESULT_CHARS, type ContextRequest, type DetailLevel, type EvidenceItem } from '../engine/types.js';
import type { IndexStore } from '../store/index-store.js';
import type { FileRow } from '../store/rows.js';
import { findCandidates } from './candidates.js';
import { expandCandidates } from './expand.js';
import { Graph, type SymbolNode, type Uncertainty } from './graph.js';
import { isPrimary, itemRef, levelRank, priority, type Item } from './items.js';
import { isUnreached, liveFiles } from './liveness.js';
import { demoteOne, planLevels, sortByPriority, type Level } from './plan.js';
import { analyzeTask } from './query.js';
import { fileHeader, itemBlock, renderContext, type NoteView } from './render.js';
import { FileViews } from './views.js';

export interface ContextDeps {
  store: IndexStore;
  guard: RepoGuard;
  /** Resolve 'path', 'path#Qual' or 'Name' focus refs to index nodes; unknown refs are pushed to `misses`. */
  resolveFocus: (graph: Graph, ref: string, misses: Uncertainty[]) => Array<{ file: FileRow; node: SymbolNode | null }>;
  notesFor: (paths: string[], task: string, limit: number) => NoteView[];
}

export interface ContextPlanResult {
  text: string;
  estTokens: number;
  complete: boolean;
  items: EvidenceItem[];
  omitted: string[];
  /** Keys rendered at their final level (cursor continuation excludes them). */
  delivered: string[];
  hasMore: boolean;
  /** Files whose disk content changed after indexing; caller must re-index and retry. */
  stale: string[];
}

export interface CompileOptions {
  budget: number;
  detail: 'auto' | DetailLevel;
  includeTests: boolean;
  exclude: ReadonlySet<string>;
  sentBefore?: ReadonlySet<string>;
  cursor?: string;
  generation: number;
  page: number;
}

const FILE_HEADER_FALLBACK = 18;

function evidence(item: Item, level: DetailLevel): EvidenceItem {
  const s = item.node?.symbol;
  return {
    ref: itemRef(item),
    path: item.file.path,
    startLine: s?.startLine ?? 1,
    endLine: s?.endLine ?? Math.max(1, item.file.lineCount),
    symbol: s?.qualName,
    level,
    provenance: item.provenance,
    hash: item.file.hash.slice(0, 12),
  };
}

/**
 * The context compiler: search -> resolve -> expand -> dedupe -> choose detail
 * levels -> verify the rendered size against the budget. Returns a coherent
 * package; anything that does not fit is listed as omitted with an exact ref.
 */
export function compileContext(deps: ContextDeps, req: ContextRequest, opts: CompileOptions): ContextPlanResult {
  const graph = new Graph(deps.store);
  const query = analyzeTask(req.task);
  const focusRefs = [...(req.focus ?? []), ...query.refs];
  const misses: Uncertainty[] = [];
  const focus = focusRefs.flatMap((ref) => deps.resolveFocus(graph, ref, misses));
  const candidates = findCandidates({ store: deps.store, graph, query, focus, exclude: opts.exclude });
  if (candidates.size === 0) return emptyResult(req, opts);
  const expansion = expandCandidates(graph, candidates, {
    includeTests: opts.includeTests,
    testIntent: query.intents.tests,
    exclude: opts.exclude,
  });
  const expanded = expansion.items;
  const uncertain = [...misses, ...expansion.uncertain];
  const views = new FileViews(deps.guard);
  const items = sortByPriority([...expanded.values()]).slice(0, 120);
  const live = liveFiles(deps.store);
  for (const item of items) if (isUnreached(item.file, live)) views.unreached.add(item.file.path);
  const costCache = new Map<string, number>();
  const cost = (item: Item, level: DetailLevel): number => {
    const key = `${item.key}|${level}`;
    let value = costCache.get(key);
    if (value === undefined) {
      const view = item.file.status === 'indexed' ? views.view(item.file) : null;
      value = estimateTokens(itemBlock(item, level, view, opts.sentBefore)) + 1;
      costCache.set(key, value);
    }
    return value;
  };
  const notes = deps.notesFor([...new Set(items.slice(0, 20).map((i) => i.file.path))], req.task, 3);
  const fixedCost = estimateTokens(renderContext(baseRender(req, opts, [], new Map(), new Set(), uncertain, notes, [], false, views))) + 40;
  const plan = planLevels(items, {
    budget: opts.budget,
    detail: opts.detail,
    fixedCost,
    cost,
    fileHeaderCost: (file) =>
      file.status === 'indexed' ? estimateTokens(fileHeader(file, views.view(file), views.unreached.has(file.path))) + 2 : FILE_HEADER_FALLBACK,
  });
  if (views.stale.size > 0) return staleResult(views);
  return finalize(req, opts, items, plan.levels, uncertain, notes, views, cost);
}

function baseRender(
  req: ContextRequest,
  opts: CompileOptions,
  items: readonly Item[],
  levels: Map<string, Level>,
  covered: Set<string>,
  uncertain: Parameters<typeof renderContext>[0]['uncertain'],
  notes: readonly NoteView[],
  omitted: readonly Item[],
  complete: boolean,
  views: FileViews,
  cursor?: string,
  sourceTokens: (item: Item) => number = () => 0,
): Parameters<typeof renderContext>[0] {
  return {
    title: opts.page > 1 ? `maxify_context page ${opts.page}` : 'maxify_context',
    task: req.task,
    generation: opts.generation,
    budget: opts.budget,
    items,
    levels,
    covered,
    uncertain,
    notes,
    omitted,
    complete,
    cursor,
    sentBefore: opts.sentBefore,
    view: (file) => views.view(file) ?? { hash: file.hash, lines: [], crlf: false },
    unreached: views.unreached,
    sourceTokens,
  };
}

function coverageOf(items: readonly Item[], levels: Map<string, Level>): Set<string> {
  const covered = new Set<string>();
  const sources = items.filter((i) => levels.get(i.key) === 'source' && i.node);
  for (const item of items) {
    if ((levels.get(item.key) ?? 'omitted') === 'omitted' || !item.node) continue;
    const s = item.node.symbol;
    const container = sources.find(
      (o) =>
        o.key !== item.key &&
        o.file.id === item.file.id &&
        o.node !== null &&
        o.node.symbol.startLine <= s.startLine &&
        o.node.symbol.endLine >= s.endLine &&
        o.node.symbol.endLine - o.node.symbol.startLine > s.endLine - s.startLine,
    );
    if (container) covered.add(item.key);
  }
  return covered;
}

function finalize(
  req: ContextRequest,
  opts: CompileOptions,
  items: Item[],
  levels: Map<string, Level>,
  uncertain: Parameters<typeof renderContext>[0]['uncertain'],
  notes: readonly NoteView[],
  views: FileViews,
  cost: (item: Item, level: DetailLevel) => number,
): ContextPlanResult {
  const sourceTokens = (item: Item): number => (item.node ? cost(item, 'source') : 0);
  // Sources larger than most of the budget can only be read page by page via maxify_source;
  // once shown at a lower level they count as delivered so cursors cannot loop on them.
  const tooBig = (item: Item): boolean => item.node !== null && sourceTokens(item) > opts.budget * 0.8;
  for (let attempt = 0; attempt < 200; attempt++) {
    const covered = coverageOf(items, levels);
    const top = Math.max(...items.map(priority));
    const omitted = items.filter((i) => isOmittedImportant(i, levels, covered, top));
    const primariesOk = items.filter(isPrimary).every((i) => levels.get(i.key) === 'source' || covered.has(i.key) || i.maxLevel !== 'source');
    const complete = primariesOk && omitted.length === 0;
    const isDelivered = (i: Item): boolean => {
      const level = levels.get(i.key) ?? 'omitted';
      return level !== 'omitted' && (levelRank(level) >= levelRank(i.maxLevel) || tooBig(i));
    };
    const hasMore = omitted.some((i) => !isDelivered(i));
    const cursor = hasMore ? opts.cursor : undefined;
    const input = baseRender(req, opts, items, levels, covered, uncertain, notes, omitted, complete, views, cursor, sourceTokens);
    const draft = renderContext(input);
    const est = estimateTokens(draft);
    if ((est <= opts.budget && draft.length <= MAX_RESULT_CHARS) || !demoteOne(items, levels)) {
      const text = draft.replace('{{EST}}', String(est));
      const visible = items.filter((i) => (levels.get(i.key) ?? 'omitted') !== 'omitted' && !covered.has(i.key));
      return {
        text,
        estTokens: estimateTokens(text),
        complete,
        items: visible.map((i) => evidence(i, levels.get(i.key) as DetailLevel)),
        omitted: omitted.map(itemRef),
        delivered: visible.filter(isDelivered).map((i) => i.key).concat([...covered]),
        hasMore,
        stale: [...views.stale],
      };
    }
  }
  throw new MaxifyError('INTERNAL', 'context budget fitting did not converge');
}

function isOmittedImportant(item: Item, levels: Map<string, Level>, covered: Set<string>, top: number): boolean {
  if (covered.has(item.key)) return false;
  const level = levels.get(item.key) ?? 'omitted';
  if (isPrimary(item)) return level !== 'source' && item.maxLevel === 'source';
  if (level !== 'omitted') return false;
  return priority(item) >= 0.25 * top;
}

function staleResult(views: FileViews): ContextPlanResult {
  return { text: '', estTokens: 0, complete: false, items: [], omitted: [], delivered: [], hasMore: false, stale: [...views.stale] };
}

function emptyResult(req: ContextRequest, opts: CompileOptions): ContextPlanResult {
  const text = [
    `maxify_context · gen ${opts.generation} · no matches`,
    `task: ${req.task.replace(/\s+/g, ' ').trim().slice(0, 200)}`,
    'No indexed symbol, file or doc matched this task. Name an identifier, a file path, or pass focus=["path"]; maxify_stats scope=index shows what is indexed.',
  ].join('\n');
  return { text, estTokens: estimateTokens(text), complete: false, items: [], omitted: [], delivered: [], hasMore: false, stale: [] };
}
