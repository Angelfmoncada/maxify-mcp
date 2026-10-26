const STOP_WORDS = new Set(['a', 'an', 'and', 'or', 'the', 'of', 'to', 'in', 'for', 'on']);

/** Splits a search-box query into lower-case terms, dropping stop words and duplicates. */
export function tokenize(query: string): string[] {
  const terms = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((term) => term.length > 0 && !STOP_WORDS.has(term));
  return [...new Set(terms)];
}

/** True when every term occurs somewhere in `text` (case-insensitive substring match). */
export function matchesAllTerms(text: string, terms: readonly string[]): boolean {
  const haystack = text.toLowerCase();
  return terms.every((term) => haystack.includes(term));
}

/** Splits `text` into segments, flagging those that match a search term so the UI can highlight them. */
export function highlightTerms(text: string, terms: readonly string[]): Array<{ text: string; match: boolean }> {
  if (terms.length === 0) return [{ text, match: false }];
  const escaped = terms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const pattern = new RegExp(`(${escaped.join('|')})`, 'gi');
  return text
    .split(pattern)
    .filter((part) => part.length > 0)
    .map((part) => ({ text: part, match: terms.includes(part.toLowerCase()) }));
}
