const CAMEL_BOUNDARY = /(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/;
const NON_WORD = /[^\p{L}\p{N}]+/u;

/** Split an identifier into lowercase parts: requireAuth -> [require, auth]; HTTPServer -> [http, server]. */
export function splitIdentifier(identifier: string): string[] {
  const parts: string[] = [];
  for (const chunk of identifier.split(NON_WORD)) {
    if (chunk.length === 0) continue;
    for (const part of chunk.split(CAMEL_BOUNDARY)) {
      if (part.length > 0) parts.push(part.toLowerCase());
    }
  }
  return parts;
}

/** Search terms for declared names: every lowercase part plus each whole name, deduplicated, in order. */
export function identifierTerms(names: readonly string[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (term: string): void => {
    if (term.length === 0 || seen.has(term)) return;
    seen.add(term);
    out.push(term);
  };
  for (const name of names) {
    for (const part of splitIdentifier(name)) push(part);
    const whole = name.toLowerCase().replace(NON_WORD, '');
    push(whole);
  }
  return out.join(' ');
}

/** Path terms: directory and file name segments split on separators and camelCase. */
export function pathTerms(relPath: string): string {
  return identifierTerms(relPath.split(/[/.\\_-]+/).filter((s) => s.length > 0));
}
