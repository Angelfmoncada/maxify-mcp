/** Unified diff parsing (git and plain `diff -u`), with exact original line spans. */

export interface Hunk {
  /** 0-based index of the @@ line. */
  start: number;
  /** Inclusive last line of the hunk. */
  end: number;
  adds: number;
  dels: number;
}

export interface DiffFile {
  start: number;
  end: number;
  path: string;
  flags: string[];
  adds: number;
  dels: number;
  hunks: Hunk[];
  /** Why the content is shown as stats only (lockfile, minified, …), or null. */
  generated: string | null;
}

export interface ParsedDiff {
  /** Lines before the first file (commit message, etc.): [0, preambleEnd). */
  preambleEnd: number;
  files: DiffFile[];
}

const HUNK = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/;
const GIT = /^diff --git (?:"?a\/)?(.+?)"? (?:"?b\/)?(.+?)"?$/;
const LOCKFILES = new Set([
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lockb',
  'Cargo.lock',
  'poetry.lock',
  'Pipfile.lock',
  'composer.lock',
  'Gemfile.lock',
  'go.sum',
]);

export function generatedReason(path: string): string | null {
  const base = path.slice(path.lastIndexOf('/') + 1);
  if (LOCKFILES.has(base)) return 'lockfile';
  if (/\.min\.[a-z0-9]+$/i.test(base)) return 'minified';
  if (/\.map$/i.test(base)) return 'source map';
  if (/(?:^|\/)(?:dist|build)\//.test(path)) return 'build output';
  return null;
}

function stripSide(p: string): string {
  return p.replace(/\t.*$/, '').replace(/^"|"$/g, '').replace(/^[ab]\//, '');
}

function newFile(start: number, path: string): DiffFile {
  return { start, end: start, path, flags: [], adds: 0, dels: 0, hunks: [], generated: null };
}

function headerLine(file: DiffFile, line: string, state: { oldPath?: string }): void {
  if (line.startsWith('--- ')) {
    const p = stripSide(line.slice(4));
    if (p !== '/dev/null') state.oldPath = p;
  } else if (line.startsWith('+++ ')) {
    const p = stripSide(line.slice(4));
    if (p !== '/dev/null') file.path = p;
    else if (state.oldPath !== undefined) file.path = state.oldPath;
  } else if (line.startsWith('new file mode')) file.flags.push('new file');
  else if (line.startsWith('deleted file mode')) file.flags.push('deleted');
  else if (line.startsWith('rename from ')) file.flags.push(`renamed from ${line.slice(12)}`);
  else if (line.startsWith('rename to ')) file.path = line.slice(10);
  else if (line.startsWith('similarity index ')) file.flags.push(`similarity ${line.slice(17)}`);
  else if (line.startsWith('old mode ')) file.flags.push(`mode ${line.slice(9)}`);
  else if (line.startsWith('new mode ')) file.flags.push(`→ ${line.slice(9)}`);
  else if (line.startsWith('Binary files ') || line === 'GIT binary patch') file.flags.push('binary');
}

/** Consumes one hunk starting at `i` (the @@ line); returns it. */
function readHunk(lines: readonly string[], i: number): Hunk {
  const m = HUNK.exec(lines[i] ?? '');
  let oldLeft = m?.[1] === undefined ? 1 : Number(m[1]);
  let newLeft = m?.[2] === undefined ? 1 : Number(m[2]);
  const hunk: Hunk = { start: i, end: i, adds: 0, dels: 0 };
  let k = i + 1;
  while (k < lines.length && (oldLeft > 0 || newLeft > 0 || (lines[k] ?? '').startsWith('\\'))) {
    const line = lines[k] ?? '';
    const c = line[0];
    if (c === '+') {
      newLeft--;
      hunk.adds++;
    } else if (c === '-') {
      oldLeft--;
      hunk.dels++;
    } else if (c === ' ' || line === '') {
      oldLeft--;
      newLeft--;
    } else if (c !== '\\') {
      break;
    }
    hunk.end = k;
    k++;
  }
  return hunk;
}

export function parseDiff(lines: readonly string[]): ParsedDiff {
  const files: DiffFile[] = [];
  let file: DiffFile | undefined;
  let state: { oldPath?: string } = {};
  let preambleEnd = lines.length;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    const git = line.startsWith('diff --git ') ? GIT.exec(line) : null;
    const plain = line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ') && (file === undefined || file.hunks.length > 0);
    if (git !== null || plain) {
      if (files.length === 0) preambleEnd = i;
      file = newFile(i, stripSide(git?.[2] ?? (lines[i + 1] ?? '').slice(4)));
      state = {};
      files.push(file);
      if (git === null) headerLine(file, line, state);
      i++;
      continue;
    }
    if (file === undefined) {
      i++;
      continue;
    }
    if (HUNK.test(line)) {
      const hunk = readHunk(lines, i);
      file.hunks.push(hunk);
      file.adds += hunk.adds;
      file.dels += hunk.dels;
      file.end = hunk.end;
      i = hunk.end + 1;
      continue;
    }
    if (file.hunks.length === 0) {
      headerLine(file, line, state);
      file.end = i;
    } else if (line.trim().length > 0) {
      file.end = i;
    }
    i++;
  }
  for (const f of files) f.generated = generatedReason(f.path);
  return { preambleEnd: files.length === 0 ? lines.length : preambleEnd, files };
}
