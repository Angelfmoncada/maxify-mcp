import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/config/config.js';
import { RepoGuard } from '../../src/core/paths.js';
import { containsPrivateKey, Exclusions } from '../../src/indexer/exclusions.js';
import { walkRepository } from '../../src/indexer/walk.js';

const root = mkdtempSync(path.join(tmpdir(), 'maxify-excl-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function write(rel: string, text = 'x\n'): void {
  const abs = path.join(root, ...rel.split('/'));
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, text);
}

write('.gitignore', 'logs/\n*.tmp\n');
write('packages/app/.gitignore', 'generated/\n');
write('.maxifyignore', 'fixtures/\n');
write('src/index.ts');
write('src/a.tmp');
write('logs/run.log');
write('packages/app/generated/out.ts');
write('packages/app/src/main.ts');
write('fixtures/sample.ts');
write('node_modules/pkg/index.js');
write('.env');
write('.env.example');
write('config/server.pem');
write('package-lock.json', '{}');

const exclusions = new Exclusions(root, { ...DEFAULT_CONFIG, extraSecretPatterns: ['vault/'] });

describe('Exclusions', () => {
  it('classifies secrets before anything else', () => {
    expect(exclusions.classify('.env')).toBe('secret');
    expect(exclusions.classify('config/server.pem')).toBe('secret');
    expect(exclusions.classify('vault', true)).toBe('secret');
    expect(exclusions.classify('.env.example')).toBe('ok');
  });

  it('respects defaults, root and nested .gitignore files, and .maxifyignore', () => {
    expect(exclusions.classify('node_modules', true)).toBe('ignored');
    expect(exclusions.classify('logs', true)).toBe('ignored');
    expect(exclusions.classify('src/a.tmp')).toBe('ignored');
    expect(exclusions.classify('packages/app/generated', true)).toBe('ignored');
    expect(exclusions.classify('fixtures', true)).toBe('ignored');
    expect(exclusions.classifyWithAncestors('packages/app/generated/out.ts')).toBe('ignored');
    expect(exclusions.classifyWithAncestors('packages/app/src/main.ts')).toBe('ok');
  });

  it('marks lockfiles as noise (listed, not parsed)', () => {
    expect(exclusions.classify('package-lock.json')).toBe('noise');
  });

  it('detects private key blocks in content', () => {
    // Built at runtime so secret scanners do not flag this fake marker.
    const fakeMarker = ['-----BEGIN RSA', 'PRIVATE KEY-----'].join(' ');
    expect(containsPrivateKey(`${fakeMarker}\nabc`)).toBe(true);
    expect(containsPrivateKey('-----BEGIN PUBLIC KEY-----')).toBe(false);
  });
});

describe('walkRepository', () => {
  it('prunes ignored and secret entries and returns sorted POSIX paths', () => {
    const { files, skipped } = walkRepository(new RepoGuard(root), exclusions);
    const paths = files.map((f) => f.path);
    expect(paths).toEqual([...paths].sort());
    expect(paths).toContain('src/index.ts');
    expect(paths).toContain('packages/app/src/main.ts');
    expect(paths).toContain('.env.example');
    expect(paths).not.toContain('.env');
    expect(paths).not.toContain('logs/run.log');
    expect(paths).not.toContain('node_modules/pkg/index.js');
    expect(paths).not.toContain('packages/app/generated/out.ts');
    expect(files.find((f) => f.path === 'package-lock.json')?.noise).toBe(true);
    expect(skipped.secret).toBeGreaterThanOrEqual(2);
  });
});
