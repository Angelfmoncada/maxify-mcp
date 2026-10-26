/**
 * Deterministic keyword extraction for the native-search simulations.
 *
 * It imitates what a competent agent would type into grep for a task prompt:
 * quoted strings first, then identifiers and paths, then the camelCase / snake_case
 * parts of those identifiers, then plain words of at least 4 characters that are not stopwords.
 * Plain words are reduced to a crude stem so "expires" also finds "expired" and "expiry" (charitable to grep).
 */

export const MAX_KEYWORDS = 10;
export const MIN_WORD_LENGTH = 4;
const MIN_PART_LENGTH = 3;

const STOPWORDS = new Set(
  (
    'about above after again all also always and any are because been before being below between both but can ' +
    'cannot could did does doing down during each either else ever every few for from further had has have having ' +
    'her here hers him his how into its itself just like make many may more most much must need needs not now off ' +
    'once only other our out over own please same shall she should show some such than that the their them then ' +
    'there these they this those through too under until upon very want wants was were what when where whether ' +
    'which while who whom whose why will with within without would you your yours tell explain find look ' +
    'change changes update add adds implement support ensure still exact exactly report reports reported ' +
    'need needs everywhere end user users also then than into onto via per'
  ).split(/\s+/),
);

const SOURCE_EXTENSIONS = /\.(ts|tsx|js|jsx|mjs|cjs|json|md|css)$/i;

/** Splits an identifier into its camelCase / snake_case / kebab-case parts, lower-cased. */
export function identifierParts(identifier: string): string[] {
  return identifier
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[\s_\-$]+/)
    .map((part) => part.toLowerCase())
    .filter((part) => part.length >= MIN_PART_LENGTH);
}

/** Crude suffix stripping: expires/expired -> expir, tasks -> task. Never shortens below 4 characters. */
export function stem(word: string): string {
  const candidates: string[] = [];
  if (word.endsWith('ies')) candidates.push(`${word.slice(0, -3)}y`);
  else if (word.endsWith('es')) candidates.push(word.slice(0, -2));
  else if (word.endsWith('ed')) candidates.push(word.slice(0, -2));
  else if (word.endsWith('ing')) candidates.push(word.slice(0, -3));
  else if (word.endsWith('s') && !word.endsWith('ss')) candidates.push(word.slice(0, -1));
  const best = candidates.find((candidate) => candidate.length >= MIN_WORD_LENGTH);
  return best ?? word;
}

function isIdentifierLike(token: string): boolean {
  return /[a-z0-9][A-Z]/.test(token) || /[A-Z]{2,}[a-z]/.test(token) || /[A-Za-z]_[A-Za-z]/.test(token) || /[A-Za-z]\d|\d[A-Za-z]/.test(token);
}

function pushUnique(list: string[], value: string): void {
  if (value.length > 0 && !list.includes(value)) list.push(value);
}

function quotedPhrases(prompt: string): string[] {
  const phrases: string[] = [];
  const patterns = [
    /"([^"\n]{3,80})"/g,
    /`([^`\n]{2,80})`/g,
    /(?<![\p{L}\p{N}])'([^'\n]{3,80})'(?![\p{L}\p{N}])/gu,
  ];
  for (const pattern of patterns) {
    for (const match of prompt.matchAll(pattern)) pushUnique(phrases, (match[1] ?? '').trim().toLowerCase());
  }
  return phrases;
}

/**
 * Keywords an agent would grep for, in priority order, at most `max` (default MAX_KEYWORDS).
 * Pure and deterministic: the same prompt always yields the same list.
 */
export function extractKeywords(prompt: string, max: number = MAX_KEYWORDS): string[] {
  const quoted = quotedPhrases(prompt);
  const identifiers: string[] = [];
  const parts: string[] = [];
  const words: string[] = [];

  // Quoted text is scanned too, so a quoted identifier also contributes its parts.
  for (const rawToken of prompt.match(/[A-Za-z0-9_$][A-Za-z0-9_$./#:-]*/g) ?? []) {
    const token = rawToken.replace(/[.:\-/#]+$/g, '');
    if (token.length === 0) continue;
    if (token.includes('/') || SOURCE_EXTENSIONS.test(token)) {
      pushUnique(identifiers, token.toLowerCase());
      for (const segment of token.split('/')) {
        const clean = segment.replace(SOURCE_EXTENSIONS, '').replace(/[^A-Za-z0-9_$-]/g, '');
        for (const part of identifierParts(clean)) pushUnique(parts, part);
      }
    } else if (isIdentifierLike(token)) {
      pushUnique(identifiers, token.toLowerCase());
      for (const part of identifierParts(token)) pushUnique(parts, part);
    } else {
      const word = token.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (word.length >= MIN_WORD_LENGTH && !STOPWORDS.has(word) && !/^\d+$/.test(word)) pushUnique(words, stem(word));
    }
  }

  const ordered: string[] = [];
  for (const group of [quoted, identifiers, parts.filter((part) => !STOPWORDS.has(part)), words]) {
    for (const keyword of group) pushUnique(ordered, keyword);
  }
  return ordered.slice(0, Math.max(max, 0));
}
