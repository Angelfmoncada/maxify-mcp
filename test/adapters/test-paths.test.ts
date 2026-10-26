import { describe, expect, it } from 'vitest';
import { isTestPath, testTargetCandidates } from '../../src/adapters/test-paths.js';

describe('isTestPath', () => {
  it('recognizes test suffixes on JS/TS files', () => {
    for (const path of ['src/a.test.ts', 'src/a.spec.tsx', 'a.test.mjs', 'b.spec.cjs', 'c.test.jsx', 'login.cy.ts', 'flow.e2e.ts']) {
      expect(isTestPath(path)).toBe(true);
    }
  });

  it('recognizes JS/TS files under test directories', () => {
    for (const path of ['src/__tests__/a.ts', 'test/helpers.js', 'tests/unit/x.ts', 'e2e/login.ts', 'cypress/support/e2e.js', 'playwright/fixtures.ts', 'packages/x/Test/y.ts']) {
      expect(isTestPath(path)).toBe(true);
    }
  });

  it('rejects other files', () => {
    for (const path of ['src/test-utils.ts', 'src/contest.ts', 'test/fixture.json', 'docs/test.md', 'src/latest/x.ts', 'src/a.ts']) {
      expect(isTestPath(path)).toBe(false);
    }
  });

  it('accepts Windows separators defensively', () => {
    expect(isTestPath('src\\__tests__\\a.ts')).toBe(true);
  });
});

describe('testTargetCandidates', () => {
  it('lists sibling module candidates for suffixed tests', () => {
    expect(testTargetCandidates('src/a/foo.test.ts')).toEqual([
      'src/a/foo.ts',
      'src/a/foo.tsx',
      'src/a/foo.js',
      'src/a/foo.jsx',
      'src/a/foo/index.ts',
      'src/a/foo/index.tsx',
      'src/a/foo/index.js',
      'src/a/foo/index.jsx',
      'src/a/foo.mts',
      'src/a/foo.cts',
      'src/a/foo.mjs',
      'src/a/foo.cjs',
    ]);
  });

  it('maps tests in a test root to src/, lib/ and the root', () => {
    const candidates = testTargetCandidates('test/foo.test.ts');
    expect(candidates.filter((c) => c.endsWith('foo.ts'))).toEqual(['src/foo.ts', 'lib/foo.ts', 'foo.ts']);
    expect(testTargetCandidates('packages/core/tests/api/client.spec.ts')).toContain('packages/core/src/api/client.ts');
  });

  it('drops grouping directories such as unit/ and integration/', () => {
    const candidates = testTargetCandidates('tests/unit/parser.test.ts');
    expect(candidates).toContain('src/unit/parser.ts');
    expect(candidates).toContain('src/parser.ts');
    expect(candidates.indexOf('src/unit/parser.ts')).toBeLessThan(candidates.indexOf('src/parser.ts'));
  });

  it('maps __tests__ directories to their parent', () => {
    const candidates = testTargetCandidates('src/__tests__/foo.test.ts');
    expect(candidates[0]).toBe('src/foo.ts');
    expect(candidates).not.toContain('src/__tests__/foo.ts');
  });

  it('skips index/index candidates and returns nothing for non-tests', () => {
    expect(testTargetCandidates('src/index.test.ts')).not.toContain('src/index/index.ts');
    expect(testTargetCandidates('src/foo.ts')).toEqual([]);
    expect(testTargetCandidates('README.md')).toEqual([]);
  });

  it('is deterministic and duplicate-free', () => {
    const first = testTargetCandidates('test/unit/foo.spec.js');
    expect(testTargetCandidates('test/unit/foo.spec.js')).toEqual(first);
    expect(new Set(first).size).toBe(first.length);
  });
});
