import { splitIdentifier } from '../indexer/terms.js';

/**
 * Task analysis: deterministic extraction of what to look for. Nothing here
 * calls a model; identifiers and paths written in the task are matched exactly,
 * prose words are matched by light stemming + prefix.
 */

export interface QueryTerm {
  /** Lowercase FTS token (no quotes). */
  term: string;
  /** Prefix match (term*) */
  prefix: boolean;
  /** Relative importance: identifiers > bigrams > words. */
  weight: number;
}

export interface TaskQuery {
  /** Identifier-looking tokens exactly as written (camelCase, snake_case, PascalCase, dotted members). */
  identifiers: string[];
  /** Path-like tokens (contain '/' or a known source extension). */
  paths: string[];
  /** Explicit refs like 'src/a.ts#Foo' or 'src/a.ts:10-20'. */
  refs: string[];
  /** Quoted strings (often error messages). */
  quoted: string[];
  terms: QueryTerm[];
  intents: { tests: boolean; docs: boolean; config: boolean };
}

const STOPWORDS = new Set(
  (
    'a an the and or but if then else when where what which who whom whose why how is are was were be been being am do does did done ' +
    'have has had having to of in on at by for with without from into onto over under about above below between through during before after ' +
    'this that these those there here it its they them their we our you your i me my he she his her not no yes can could should would will shall may might must ' +
    'also just only very more most less least some any all each every both either neither other another such same so than too very ' +
    'please make makes made use uses used using get gets got add adds added change changes changed update updates updated fix fixes fixed ' +
    'new old file files code function functions method methods class classes need needs want wants like find look see show tell help work works ' +
    'el la los las un una unos unas y o pero si sino cuando donde que quien como por para con sin de del al en sobre entre hasta desde ' +
    'es son era fue ser estar esta este estos estas ese esa eso aquel hay muy mas menos su sus mi mis tu tus nuestro nuestra lo le les se ' +
    'no ya tambien solo cada todo todos toda todas otro otra otros otras hacer hace hizo cambia cambiar arregla arreglar corrige corregir ' +
    'agrega agregar anade anadir quiero necesito busca buscar encuentra encontrar muestra mostrar archivo archivos codigo funcion funciones'
  ).split(/\s+/),
);

const TEST_WORDS = /\b(tests?|spec|specs|testing|coverage|covers?|covered|unit|e2e|pruebas?|testea|testear)\b/i;
const DOC_WORDS = /\b(docs?|documentation|readme|architecture|guide|documentacion|arquitectura|guia)\b/i;
const CONFIG_WORDS = /\b(config|configuration|tsconfig|package\.json|scripts?|env|environment|settings|configuracion|dependenc(y|ies))\b/i;
const SOURCE_EXT = /\.(?:[cm]?[jt]sx?|json|md|mdx|css|scss|html|ya?ml|toml|sql|sh|py|go|rs)$/i;

const SUFFIXES = ['ations', 'ation', 'ings', 'ing', 'ions', 'ion', 'ers', 'er', 'ies', 'ied', 'es', 'ed', 's', 'y', 'cion', 'ciones', 'mente'];

/** Light, language-agnostic stemming used only to build prefix queries. */
export function stem(word: string): string {
  for (const suffix of SUFFIXES) {
    if (word.length - suffix.length >= 4 && word.endsWith(suffix)) return word.slice(0, -suffix.length);
  }
  return word;
}

function stripAccents(text: string): string {
  return text.normalize('NFD').replace(/\p{M}+/gu, '');
}

function isIdentifierLike(token: string): boolean {
  if (/^[A-Za-z_$][\w$]*$/.test(token)) {
    return /[a-z][A-Z]|[A-Z]{2,}[a-z]|_/.test(token) || /^[A-Z][a-z]+[A-Z]/.test(token) || /^use[A-Z]/.test(token);
  }
  return /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)+$/.test(token) && !SOURCE_EXT.test(token);
}

function pushTerm(terms: Map<string, QueryTerm>, term: string, prefix: boolean, weight: number): void {
  if (term.length < 2) return;
  const existing = terms.get(term);
  if (!existing || existing.weight < weight) terms.set(term, { term, prefix: existing ? existing.prefix || prefix : prefix, weight });
}

function collectTokens(task: string): { quoted: string[]; tokens: string[] } {
  const quoted: string[] = [];
  for (const match of task.matchAll(/"([^"\n]{3,200})"|'([^'\n]{3,200})'|`([^`\n]{2,200})`/g)) {
    const value = match[1] ?? match[2] ?? match[3];
    if (value) quoted.push(value);
  }
  const tokens = task.split(/[\s,;()[\]{}<>"'`!?¿¡]+/).map((t) => t.replace(/^[.:]+|[.:]+$/g, '')).filter((t) => t.length > 0);
  return { quoted, tokens };
}

export function analyzeTask(task: string): TaskQuery {
  const { quoted, tokens } = collectTokens(task);
  const identifiers: string[] = [];
  const paths: string[] = [];
  const refs: string[] = [];
  const terms = new Map<string, QueryTerm>();
  const proseWords: string[] = [];
  for (const token of tokens) {
    if (/^[\w@./-]+(#[\w$.~]+|:\d+(-\d+)?)$/.test(token) && token.includes('/')) {
      refs.push(token);
      continue;
    }
    if (token.includes('/') || SOURCE_EXT.test(token)) {
      paths.push(token.replace(/^\.\//, ''));
      for (const part of token.split(/[/.\\_-]+/)) if (part.length >= 3) pushTerm(terms, stripAccents(part.toLowerCase()), false, 1.2);
      continue;
    }
    if (isIdentifierLike(token)) {
      identifiers.push(token);
      const last = token.split('.').pop() ?? token;
      pushTerm(terms, last.toLowerCase(), false, 2.0);
      for (const part of splitIdentifier(token)) if (!STOPWORDS.has(part)) pushTerm(terms, part, part.length >= 5, 1.2);
      continue;
    }
    for (const word of splitIdentifier(stripAccents(token))) proseWords.push(word);
  }
  const kept = proseWords.filter((w) => w.length >= 3 && !STOPWORDS.has(w) && !/^\d+$/.test(w));
  kept.forEach((word, i) => {
    const stemmed = stem(word);
    pushTerm(terms, stemmed, stemmed.length >= 4, 1.0);
    const next = kept[i + 1];
    if (next) pushTerm(terms, `${word}${next}`, false, 1.3);
  });
  for (const q of quoted) {
    for (const word of splitIdentifier(stripAccents(q))) if (word.length >= 3 && !STOPWORDS.has(word)) pushTerm(terms, stem(word), word.length >= 5, 1.1);
  }
  return {
    identifiers: [...new Set(identifiers)],
    paths: [...new Set(paths)],
    refs: [...new Set(refs)],
    quoted,
    terms: [...terms.values()].sort((a, b) => b.weight - a.weight || (a.term < b.term ? -1 : 1)).slice(0, 24),
    intents: { tests: TEST_WORDS.test(task), docs: DOC_WORDS.test(task), config: CONFIG_WORDS.test(task) },
  };
}

/** FTS5 MATCH expression for one term: always quoted so user text can never inject query syntax. */
export function ftsTerm(term: QueryTerm): string {
  const quoted = `"${term.term.replace(/"/g, '""')}"`;
  return term.prefix ? `${quoted}*` : quoted;
}

export function ftsOr(terms: readonly QueryTerm[]): string {
  return terms.map(ftsTerm).join(' OR ');
}
