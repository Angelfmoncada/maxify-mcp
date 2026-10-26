/**
 * Test-file conventions. `isTestPath` recognizes JS/TS test files by name
 * (*.test.*, *.spec.*, *.cy.*, *.e2e.*) or location (__tests__/, test/,
 * tests/, e2e/, cypress/, playwright/). `testTargetCandidates` lists, in
 * priority order, the paths a test most likely exercises by naming
 * convention only; the engine links them with provenance 'heuristic'.
 */
import { extensionOf } from './shared.js';

const CODE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);
const TEST_DIRS = new Set(['__tests__', 'test', 'tests', 'e2e', 'cypress', 'playwright']);
/** Directories that group tests by type (test/unit/foo.test.ts -> src/foo.ts). */
const GROUPING_DIRS = new Set(['unit', 'integration', 'functional', 'spec', 'specs']);
const TEST_SUFFIX = /\.(test|spec|cy|e2e)$/i;
const MAIN_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx'];
const MODULE_EXTENSIONS = ['.mts', '.cts', '.mjs', '.cjs'];
const SOURCE_ROOTS = ['src', 'lib', ''];

interface PathParts {
  readonly normalized: string;
  readonly dirs: readonly string[];
  /** File name without its extension. */
  readonly stem: string;
  readonly ext: string;
}

function parsePath(relPath: string): PathParts {
  const normalized = relPath.replace(/\\/g, '/').replace(/^(\.\/)+/, '');
  const parts = normalized.split('/').filter((part) => part !== '' && part !== '.');
  const file = parts[parts.length - 1] ?? '';
  const ext = extensionOf(file);
  return { normalized, dirs: parts.slice(0, -1), stem: file.slice(0, file.length - ext.length), ext };
}

/** True for JS/TS test files, by suffix or by test directory. */
export function isTestPath(relPath: string): boolean {
  const { dirs, stem, ext } = parsePath(relPath);
  if (!CODE_EXTENSIONS.has(ext)) return false;
  if (TEST_SUFFIX.test(stem)) return true;
  return dirs.some((dir) => TEST_DIRS.has(dir.toLowerCase()));
}

function withRoot(before: readonly string[], root: string, after: readonly string[]): string[] {
  return [...before, ...(root === '' ? [] : [root]), ...after];
}

/** Directory candidates for the module under test (outermost test directory decides). */
function candidateDirs(dirs: readonly string[]): string[][] {
  const testIndex = dirs.findIndex((dir) => TEST_DIRS.has(dir.toLowerCase()));
  if (testIndex === -1) return [[...dirs]];
  const before = dirs.slice(0, testIndex);
  const after = dirs.slice(testIndex + 1);
  if (dirs[testIndex]?.toLowerCase() === '__tests__') return [[...before, ...after]];
  const mirrored = SOURCE_ROOTS.map((root) => withRoot(before, root, after));
  const first = after[0];
  if (first === undefined || !GROUPING_DIRS.has(first.toLowerCase())) return mirrored;
  return [...mirrored, ...SOURCE_ROOTS.map((root) => withRoot(before, root, after.slice(1)))];
}

/**
 * Naming-convention candidates for the module a test file exercises, e.g.
 * `src/a/foo.test.ts` -> `src/a/foo.ts`, `src/a/foo.tsx`, ..., `src/a/foo/index.ts`, ...;
 * `test/foo.test.ts` -> `src/foo.*`, `lib/foo.*`, `foo.*`. Empty for non-test paths.
 */
export function testTargetCandidates(relPath: string): string[] {
  if (!isTestPath(relPath)) return [];
  const { normalized, dirs, stem } = parsePath(relPath);
  const base = stem.replace(TEST_SUFFIX, '');
  if (base === '') return [];
  const candidates: string[] = [];
  for (const dirParts of candidateDirs(dirs)) {
    const prefix = dirParts.length > 0 ? `${dirParts.join('/')}/` : '';
    for (const ext of MAIN_EXTENSIONS) candidates.push(`${prefix}${base}${ext}`);
    if (base !== 'index') for (const ext of MAIN_EXTENSIONS) candidates.push(`${prefix}${base}/index${ext}`);
    for (const ext of MODULE_EXTENSIONS) candidates.push(`${prefix}${base}${ext}`);
  }
  return [...new Set(candidates)].filter((candidate) => candidate !== normalized);
}
