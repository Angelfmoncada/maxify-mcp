/**
 * Span-preserving JSON scanner for text that JSON.parse already accepted.
 * Nodes keep exact source offsets and 1-based lines, so values can be shown
 * as their exact (minified) source text — big integers and duplicate keys
 * are never re-serialized.
 */

export type JType = 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null';

export interface JNode {
  type: JType;
  start: number;
  end: number;
  line: number;
  endLine: number;
  /** Decoded member keys (objects). */
  keys?: string[];
  /** Member keys exactly as written between the quotes. */
  rawKeys?: string[];
  children?: JNode[];
  /** True when nesting was too deep to expand. */
  opaque?: boolean;
}

const MAX_DEPTH = 400;

function isWs(c: number): boolean {
  return c === 32 || c === 9 || c === 10 || c === 13;
}

/** - + . 0-9 e E */
function isNumberChar(c: number): boolean {
  return (c >= 48 && c <= 57) || c === 45 || c === 43 || c === 46 || c === 101 || c === 69;
}

class Scanner {
  pos = 0;
  line = 1;

  constructor(private readonly text: string) {}

  ws(): void {
    const t = this.text;
    while (this.pos < t.length) {
      const c = t.charCodeAt(this.pos);
      if (!isWs(c)) break;
      if (c === 10) this.line++;
      this.pos++;
    }
  }

  /** Skips a string starting at pos (on the opening quote); returns its raw inner text. */
  str(): string {
    const t = this.text;
    const open = this.pos;
    let i = open + 1;
    while (i < t.length) {
      const c = t.charCodeAt(i);
      if (c === 92) i += 2;
      else if (c === 34) break;
      else i++;
    }
    this.pos = i + 1;
    return t.slice(open + 1, i);
  }

  /** Skips any value without building nodes (used past MAX_DEPTH). */
  skip(): void {
    const t = this.text;
    let depth = 0;
    do {
      const c = t.charCodeAt(this.pos);
      if (c === 34) {
        this.str();
        continue;
      }
      if (c === 123 || c === 91) depth++;
      else if (c === 125 || c === 93) depth--;
      else if (c === 10) this.line++;
      this.pos++;
    } while (depth > 0 && this.pos < t.length);
  }

  value(depth: number): JNode {
    this.ws();
    const start = this.pos;
    const line = this.line;
    const c = this.text.charCodeAt(start);
    const done = (type: JType, extra: Partial<JNode> = {}): JNode => ({
      type,
      start,
      end: this.pos,
      line,
      endLine: this.line,
      ...extra,
    });
    if (c === 123 || c === 91) {
      if (depth >= MAX_DEPTH) {
        this.skip();
        return done(c === 123 ? 'object' : 'array', { opaque: true });
      }
      return c === 123 ? this.object(depth, done) : this.array(depth, done);
    }
    if (c === 34) {
      this.str();
      return done('string');
    }
    if (c === 116 || c === 102 || c === 110) {
      this.pos += c === 102 ? 5 : 4;
      return done(c === 110 ? 'null' : 'boolean');
    }
    while (this.pos < this.text.length && isNumberChar(this.text.charCodeAt(this.pos))) this.pos++;
    return done('number');
  }

  private object(depth: number, done: (t: JType, e: Partial<JNode>) => JNode): JNode {
    const keys: string[] = [];
    const rawKeys: string[] = [];
    const children: JNode[] = [];
    this.pos++;
    this.ws();
    while (this.text.charCodeAt(this.pos) !== 125 && this.pos < this.text.length) {
      const raw = this.str();
      rawKeys.push(raw);
      keys.push(raw.includes('\\') ? (JSON.parse(`"${raw}"`) as string) : raw);
      this.ws();
      this.pos++; // ':'
      children.push(this.value(depth + 1));
      this.ws();
      if (this.text.charCodeAt(this.pos) === 44) {
        this.pos++;
        this.ws();
      }
    }
    this.pos++;
    return done('object', { keys, rawKeys, children });
  }

  private array(depth: number, done: (t: JType, e: Partial<JNode>) => JNode): JNode {
    const children: JNode[] = [];
    this.pos++;
    this.ws();
    while (this.text.charCodeAt(this.pos) !== 93 && this.pos < this.text.length) {
      children.push(this.value(depth + 1));
      this.ws();
      if (this.text.charCodeAt(this.pos) === 44) {
        this.pos++;
        this.ws();
      }
    }
    this.pos++;
    return done('array', { children });
  }
}

/** Tree of `text` (must be valid JSON, BOM already removed). */
export function scanJson(text: string): JNode {
  return new Scanner(text).value(0);
}

/** Removes insignificant whitespace outside strings; everything else stays byte-identical. */
export function minifyJson(text: string, start = 0, end = text.length): string {
  const parts: string[] = [];
  let runStart = start;
  let i = start;
  while (i < end) {
    const c = text.charCodeAt(i);
    if (c === 34) {
      i++;
      while (i < end) {
        const d = text.charCodeAt(i);
        if (d === 92) i += 2;
        else if (d === 34) {
          i++;
          break;
        } else i++;
      }
      continue;
    }
    if (isWs(c)) {
      if (i > runStart) parts.push(text.slice(runStart, i));
      while (i < end && isWs(text.charCodeAt(i))) i++;
      runStart = i;
      continue;
    }
    i++;
  }
  if (end > runStart) parts.push(text.slice(runStart, end));
  return parts.join('');
}
