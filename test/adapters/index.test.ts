import { describe, expect, it } from 'vitest';
import { ADAPTER_VERSION, ADAPTERS, adapterFor, isTestPath, testTargetCandidates } from '../../src/adapters/index.js';

describe('adapter registry', () => {
  it('exposes the four adapters and a version', () => {
    expect(ADAPTERS.map((a) => a.id)).toEqual(['typescript', 'markdown', 'json', 'text']);
    expect(ADAPTER_VERSION).toBe('1');
    expect(typeof isTestPath).toBe('function');
    expect(typeof testTargetCandidates).toBe('function');
  });

  it('picks adapters by extension', () => {
    const cases: Array<[string, string]> = [
      ['src/a.ts', 'typescript'],
      ['src/a.tsx', 'typescript'],
      ['src/a.d.ts', 'typescript'],
      ['src/a.mjs', 'typescript'],
      ['src/A.JSX', 'typescript'],
      ['README.md', 'markdown'],
      ['docs/page.mdx', 'markdown'],
      ['data/x.json', 'json'],
      ['styles/app.scss', 'text'],
      ['main.py', 'text'],
      ['config.yaml', 'text'],
    ];
    for (const [path, id] of cases) expect(adapterFor(path)?.id).toBe(id);
  });

  it('matches exact file names first', () => {
    expect(adapterFor('package.json')?.id).toBe('json');
    expect(adapterFor('apps/web/tsconfig.json')?.id).toBe('json');
    expect(jsonFileNames()).toContain('package.json');
  });

  it('returns null for unknown, binary and extension-less files', () => {
    for (const path of ['logo.png', 'font.woff2', 'archive.zip', 'Makefile', '.gitignore', '.env', 'bin/tool']) {
      expect(adapterFor(path)).toBeNull();
    }
  });

  it('parses through the registry for every adapter', () => {
    expect(adapterFor('x.ts')?.parse('x.ts', 'export const a = 1;').symbols).toHaveLength(1);
    expect(adapterFor('x.md')?.parse('x.md', '# A').symbols).toHaveLength(1);
    expect(adapterFor('x.json')?.parse('x.json', '{"a":1}').symbols).toHaveLength(1);
    expect(adapterFor('x.txt')?.parse('x.txt', 'hello').symbols).toHaveLength(1);
  });
});

function jsonFileNames(): readonly string[] {
  return ADAPTERS.find((a) => a.id === 'json')?.fileNames ?? [];
}
