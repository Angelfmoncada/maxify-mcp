import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** Small but realistic repo: path alias, barrel re-export, dynamic import, decoy, test, docs and a secret. */
export const MINI_REPO: Record<string, string> = {
  'package.json': JSON.stringify({ name: 'mini', type: 'module', scripts: { test: 'node --test' } }, null, 2),
  'tsconfig.json': JSON.stringify(
    { compilerOptions: { moduleResolution: 'bundler', module: 'esnext', allowImportingTsExtensions: true, noEmit: true, paths: { '@lib/*': ['./src/lib/*'] } } },
    null,
    2,
  ),
  'src/lib/token.ts': [
    '/** Payload carried by an auth token. */',
    'export interface TokenPayload {',
    '  sub: string;',
    '  /** Expiry, seconds since epoch. */',
    '  exp: number;',
    '}',
    '',
    '/** True when the token is expired at `now` (seconds). */',
    'export function isExpired(payload: TokenPayload, now: number): boolean {',
    '  return now > payload.exp;',
    '}',
    '',
    'export function verifyToken(raw: string, now: number): TokenPayload {',
    '  const payload = JSON.parse(raw) as TokenPayload;',
    "  if (isExpired(payload, now)) throw new Error('token expired');",
    '  return payload;',
    '}',
    '',
  ].join('\n'),
  'src/lib/index.ts': "export * from './token.ts';\n",
  'src/auth.ts': [
    "import { verifyToken } from '@lib/index.ts';",
    '',
    '/** Returns the subject of a valid bearer token or throws. */',
    'export function requireAuth(header: string | undefined, now: number): string {',
    "  if (!header) throw new Error('missing token');",
    '  return verifyToken(header, now).sub;',
    '}',
    '',
  ].join('\n'),
  'src/plugins.ts': ['export async function loadPlugin(name: string): Promise<unknown> {', '  return import(`./plugins/${name}.ts`);', '}', ''].join('\n'),
  'src/legacy/old-auth.ts': ['export function checkTokenLegacy(token: string): boolean {', '  return token.length > 0;', '}', ''].join('\n'),
  'test/token.test.ts': [
    "import { test } from 'node:test';",
    "import { isExpired } from '../src/lib/token.ts';",
    '',
    "test('isExpired is true after exp', () => {",
    "  if (!isExpired({ sub: 'a', exp: 1 }, 2)) throw new Error('expected expiry');",
    '});',
    '',
  ].join('\n'),
  'README.md': '# Mini\n\n## Auth\n\nTokens expire at `exp` seconds.\n',
  '.env': 'SECRET=do-not-read\n',
};

export function writeRepo(files: Record<string, string>, prefix = 'maxify-mini-'): string {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  for (const [rel, text] of Object.entries(files)) {
    const abs = path.join(root, ...rel.split('/'));
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, text);
  }
  return root;
}

/** Every fenced block in `text` must be an exact slice of the file it claims (no silent truncation/paraphrase). */
export function fencedBlocks(text: string): string[] {
  const out: string[] = [];
  const re = /^(`{3,})[^\n]*\n([\s\S]*?)\n\1$/gm;
  for (const m of text.matchAll(re)) out.push(m[2] ?? '');
  return out;
}
