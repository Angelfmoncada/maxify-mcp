/** Fixture access: locating, reading, copying and editing the benchmark repository. */
import {
  cpSync,
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EditSpec } from './offline-types.js';

export const FIXTURE_NAME = 'taskboard';

const TEXT_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.md', '.css']);
const SKIPPED_DIRECTORIES = new Set(['node_modules', '.git', 'dist', 'coverage']);

/** Repository root: this file lives in src/bench (or dist/bench), two levels below it. */
export function repoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
}

export function benchDir(root: string = repoRoot()): string {
  return path.join(root, 'bench');
}

export function fixtureDir(root: string = repoRoot()): string {
  return path.join(benchDir(root), 'fixtures', FIXTURE_NAME);
}

export function tasksDir(root: string = repoRoot()): string {
  return path.join(benchDir(root), 'tasks');
}

function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

function walk(dir: string, base: string, out: string[]): void {
  for (const name of readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(name)) walk(full, base, out);
    } else if (TEXT_EXTENSIONS.has(path.extname(name).toLowerCase())) {
      out.push(toPosix(path.relative(base, full)));
    }
  }
}

/** Every text file of the repository as POSIX path -> content, in sorted path order. */
export function readFixtureFiles(root: string): Map<string, string> {
  const paths: string[] = [];
  walk(root, root, paths);
  const files = new Map<string, string>();
  for (const rel of paths) files.set(rel, readFileSync(path.join(root, ...rel.split('/')), 'utf8'));
  return files;
}

/** Copies the fixture (without node_modules or .git) so benchmark runs never touch the original. */
export function copyFixture(source: string, destination: string): void {
  if (!existsSync(source)) throw new Error(`Fixture not found: ${source}`);
  cpSync(source, destination, {
    recursive: true,
    filter: (entry) => !SKIPPED_DIRECTORIES.has(path.basename(entry)),
  });
}

/** Replaces the single occurrence of `edit.find` in `text`. Throws unless it occurs exactly once. */
export function replaceOnce(text: string, edit: EditSpec): string {
  const first = text.indexOf(edit.find);
  if (first < 0) throw new Error(`edit target not found in ${edit.file}: ${JSON.stringify(edit.find.slice(0, 60))}`);
  if (text.indexOf(edit.find, first + 1) >= 0) {
    throw new Error(`edit target is ambiguous in ${edit.file}: ${JSON.stringify(edit.find.slice(0, 60))}`);
  }
  return text.slice(0, first) + edit.replace + text.slice(first + edit.find.length);
}

/** Pure variant of an edit: returns a new file map; the input map is left untouched. */
export function applyEditToFiles(files: ReadonlyMap<string, string>, edit: EditSpec): Map<string, string> {
  const text = files.get(edit.file);
  if (text === undefined) throw new Error(`edit file not found in fixture: ${edit.file}`);
  const next = new Map(files);
  next.set(edit.file, replaceOnce(text, edit));
  return next;
}

let touchCounter = 0;

/** Writes a file and moves its mtime forward so mtime-based change detection always notices it. */
export function writeFileFresh(file: string, content: string): void {
  writeFileSync(file, content);
  touchCounter += 1;
  const when = new Date(Date.now() + touchCounter * 2000);
  utimesSync(file, when, when);
}

export interface AppliedEdit {
  file: string;
  original: string;
}

/** Applies an edit on disk and returns what is needed to undo it. */
export function applyEditOnDisk(root: string, edit: EditSpec): AppliedEdit {
  const file = path.join(root, ...edit.file.split('/'));
  const original = readFileSync(file, 'utf8');
  writeFileFresh(file, replaceOnce(original, edit));
  return { file, original };
}

export function revertEdit(applied: AppliedEdit): void {
  writeFileFresh(applied.file, applied.original);
}

/** Line count of the whole repository text, used in the report header. */
export function totalLines(files: ReadonlyMap<string, string>): number {
  let total = 0;
  for (const text of files.values()) total += text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
  return total;
}
