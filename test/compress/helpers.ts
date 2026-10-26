/**
 * Test helpers: fixture loading, an independent checker for the body format
 * (markers must point at the right original lines), and deterministic
 * generators for large realistic inputs.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export function fixture(name: string): string {
  return readFileSync(path.join(HERE, 'fixtures', name), 'utf8');
}

// Deliberately separate from src/compress/lines.ts so the check is independent.
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b\[[0-?]*[ -/]*[@-~]|\u001b[@-Z\\-_]/g;

export function originalLines(text: string): string[] {
  const parts = text.split(/\r?\n/);
  if (parts.length > 1 && parts[parts.length - 1] === '') parts.pop();
  return parts;
}

/** Original line as the compressor shows it (ANSI stripped, \r redraw collapsed, trailing spaces trimmed). */
export function cleanLine(line: string, trim = true): string {
  let s = line.replace(ANSI, '');
  if (s.includes('\r')) {
    const segs = s.split('\r').filter((x) => x.trim().length > 0);
    s = segs[segs.length - 1] ?? '';
  }
  return trim ? s.trimEnd() : s;
}

function expandRefs(refs: string): number[] {
  const out: number[] = [];
  for (const part of refs.split(', ')) {
    const m = /^L(\d+)(?:-L(\d+))?$/.exec(part.trim());
    if (m === null) throw new Error(`bad ref "${part}"`);
    const a = Number(m[1]);
    const b = m[2] === undefined ? a : Number(m[2]);
    for (let n = a; n <= b; n++) out.push(n);
  }
  return out;
}

export interface MarkerReport {
  /** Number of verbatim lines checked against the original. */
  checked: number;
  runs: number;
  omissions: number;
  errors: string[];
}

/**
 * Verifies the body format: every "» La-Lb" run is followed by exactly those
 * original lines, every "(Lrefs):" marker by those lines, every omission's
 * count equals its range length, and `summary:` lines only appear before the
 * first marker.
 */
export function checkMarkers(original: string, body: string, opts: { trim?: boolean; marker?: string } = {}): MarkerReport {
  const orig = originalLines(original);
  const trim = opts.trim ?? true;
  const marker = opts.marker ?? '»';
  const lines = body.split('\n');
  const report: MarkerReport = { checked: 0, runs: 0, omissions: 0, errors: [] };
  const expectLines = (at: number, nums: readonly number[]): void => {
    nums.forEach((n, k) => {
      const want = cleanLine(orig[n - 1] ?? '<<missing>>', trim);
      const got = lines[at + k];
      if (got !== want) report.errors.push(`L${n}: expected ${JSON.stringify(want)} got ${JSON.stringify(got)}`);
      report.checked++;
    });
  };
  let seenMarker = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (!line.startsWith(`${marker} `)) {
      if (line.startsWith('summary: ') && seenMarker) report.errors.push(`summary after a marker at output line ${i + 1}`);
      continue;
    }
    seenMarker = true;
    const rest = line.slice(marker.length + 1);
    const run = /^L(\d+)(?:-L(\d+))?$/.exec(rest);
    if (run !== null) {
      const a = Number(run[1]);
      const b = run[2] === undefined ? a : Number(run[2]);
      const nums = Array.from({ length: b - a + 1 }, (_, k) => a + k);
      expectLines(i + 1, nums);
      report.runs++;
      i += nums.length;
      continue;
    }
    const omit = /^L(\d+)(?:-L(\d+))? omitted: (\d+) lines? \(/.exec(rest);
    if (omit !== null) {
      const a = Number(omit[1]);
      const b = omit[2] === undefined ? a : Number(omit[2]);
      if (Number(omit[3]) !== b - a + 1) report.errors.push(`omission count mismatch: ${line}`);
      report.omissions++;
      continue;
    }
    const refs = /\((L\d+(?:-L\d+)?(?:, L\d+(?:-L\d+)?)*)\):$/.exec(rest);
    if (refs !== null) {
      const nums = expandRefs(refs[1] ?? '');
      expectLines(i + 1, nums);
      i += nums.length;
    }
  }
  return report;
}

/**
 * Original lines not referenced by any marker range (runs, omissions, repeat
 * and group headers). "between La and Lb" counts as covering La..Lb.
 * An empty result means nothing was dropped silently.
 */
export function uncoveredLines(original: string, body: string, marker = '»'): number[] {
  const total = originalLines(original).length;
  const covered = new Uint8Array(total + 2);
  const mark = (a: number, b: number): void => {
    for (let n = a; n <= b && n <= total; n++) covered[n] = 1;
  };
  for (const line of body.split('\n')) {
    if (!line.startsWith(`${marker} `)) continue;
    for (const m of line.matchAll(/\bL(\d+)(?:-L(\d+))?\b/g)) mark(Number(m[1]), Number(m[2] ?? m[1]));
    for (const m of line.matchAll(/between L(\d+) and L(\d+)/g)) mark(Number(m[1]), Number(m[2]));
  }
  const missing: number[] = [];
  for (let n = 1; n <= total; n++) if (covered[n] !== 1) missing.push(n);
  return missing;
}

/** Deterministic PRNG (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hex(rand: () => number, len: number): string {
  let s = '';
  while (s.length < len) s += Math.floor(rand() * 16).toString(16);
  return s;
}

function b64(rand: () => number, len: number): string {
  const abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let s = '';
  while (s.length < len) s += abc[Math.floor(rand() * 64)];
  return `${s}==`;
}

/** BuildKit `--progress=plain` log with thousands of layer download progress lines and a failing build step. */
export function dockerBuildLog(): string {
  const rand = rng(7);
  const out: string[] = [
    '#0 building with "default" instance using docker driver',
    '',
    '#1 [internal] load build definition from Dockerfile',
    '#1 transferring dockerfile: 1.21kB done',
    '#1 DONE 0.0s',
    '',
    '#2 [internal] load metadata for docker.io/library/node:20-alpine',
    '#2 DONE 1.4s',
    '',
    '#3 [internal] load .dockerignore',
    '#3 transferring context: 112B done',
    '#3 DONE 0.0s',
    '',
    '#4 [base 1/1] FROM docker.io/library/node:20-alpine@sha256:7e227295e96f5b00aa79555ae166f50610940d888fc2e321cf36304cbd17d7d6',
    '#4 resolve docker.io/library/node:20-alpine@sha256:7e227295e96f5b00aa79555ae166f50610940d888fc2e321cf36304cbd17d7d6 0.0s done',
  ];
  const layers = [3.35, 49.55, 1.26, 0.45].map((size) => ({ size, sha: hex(rand, 64) }));
  let t = 0.1;
  for (const layer of layers) {
    const steps = 600;
    for (let s = 0; s <= steps; s++) {
      const done = ((layer.size * s) / steps).toFixed(2);
      out.push(`#4 sha256:${layer.sha} ${done}MB / ${layer.size.toFixed(2)}MB ${t.toFixed(1)}s`);
      t += 0.1;
    }
    out.push(`#4 sha256:${layer.sha} ${layer.size.toFixed(2)}MB / ${layer.size.toFixed(2)}MB ${t.toFixed(1)}s done`);
    out.push(`#4 extracting sha256:${layer.sha} 0.${Math.floor(rand() * 9) + 1}s done`);
  }
  out.push(
    `#4 DONE ${t.toFixed(1)}s`,
    '',
    '#5 [internal] load build context',
    '#5 transferring context: 2.41MB 0.2s done',
    '#5 DONE 0.3s',
    '',
    '#6 [deps 2/4] WORKDIR /app',
    '#6 DONE 0.1s',
    '',
    '#7 [deps 3/4] COPY package.json package-lock.json ./',
    '#7 DONE 0.0s',
    '',
    '#8 [deps 4/4] RUN npm ci --no-audit --no-fund',
    '#8 1.912 npm WARN deprecated inflight@1.0.6: This module is not supported, and leaks memory. Do not use it.',
    '#8 2.004 npm WARN deprecated glob@7.2.3: Glob versions prior to v9 are no longer supported',
    '#8 14.517 ',
    '#8 14.517 added 1342 packages in 14s',
    '#8 DONE 15.1s',
    '',
    '#9 [build 1/3] COPY . .',
    '#9 DONE 0.4s',
    '',
    '#10 [build 2/3] RUN npm run build',
    '#10 0.501 ',
    '#10 0.501 > shop-web@1.4.0 build',
    '#10 0.501 > vite build',
    '#10 0.502 ',
    '#10 1.338 vite v5.2.8 building for production...',
    '#10 1.402 transforming...',
    '#10 4.112 ✓ 1532 modules transformed.',
    '#10 4.113 x Build failed in 2.71s',
    '#10 4.114 error during build:',
    '#10 4.114 [vite:esbuild] Transform failed with 1 error:',
    '#10 4.114 /app/src/pages/Checkout.tsx:88:12: ERROR: Expected ")" but found "}"',
    '#10 4.114     at failureErrorWithLog (/app/node_modules/esbuild/lib/main.js:1651:15)',
    '#10 4.114     at /app/node_modules/esbuild/lib/main.js:849:29',
    '#10 4.115     at Socket.emit (node:events:519:28)',
    '#10 4.181 npm ERR! Lifecycle script `build` failed with error:',
    '#10 4.181 npm ERR! Error: command failed',
    '#10 ERROR: process "/bin/sh -c npm run build" did not complete successfully: exit code: 1',
    '------',
    ' > [build 2/3] RUN npm run build:',
    '4.181 npm ERR! Lifecycle script `build` failed with error:',
    '4.181 npm ERR! Error: command failed',
    '------',
    'Dockerfile:14',
    '--------------------',
    '  12 |     FROM deps AS build',
    '  13 |     COPY . .',
    '  14 | >>> RUN npm run build',
    '  15 |     ',
    '  16 |     FROM nginx:1.25-alpine',
    '--------------------',
    'ERROR: failed to solve: process "/bin/sh -c npm run build" did not complete successfully: exit code: 1',
  );
  return `${out.join('\n')}\n`;
}

const RG_TEXTS = [
  "import { useAuth } from '@/hooks/useAuth';",
  '  const { user, isAuthenticated } = useAuth();',
  '  const auth = useAuth();',
  '  const { logout } = useAuth();',
  '  // useAuth() must be called inside <AuthProvider>',
  '  if (!useAuth().user) return <Navigate to="/login" replace />;',
  '    const { result } = renderHook(() => useAuth(), { wrapper });',
  "vi.mock('@/hooks/useAuth', () => ({ useAuth: vi.fn() }));",
  '  expect(useAuth).toHaveBeenCalledTimes(1);',
  '  const { permissions } = useAuth({ refresh: true });',
  '    const { token } = useAuth();',
  '  const isAdmin = useAuth().user?.role === "admin";',
];

/** `rg -n useAuth` style output: ~500 matches in ~40 files. */
export function rgOutput(): string {
  const rand = rng(42);
  const dirs = ['src/pages', 'src/components', 'src/components/account', 'src/features/checkout', 'src/hooks', 'test/unit'];
  const names = ['Account', 'Orders', 'Checkout', 'Login', 'Header', 'NavBar', 'ProfileMenu', 'Settings', 'Billing', 'Wishlist', 'Cart', 'Admin', 'Reports', 'Dashboard', 'Invoices', 'Support', 'Search', 'Profile', 'Security', 'Sessions'];
  const out: string[] = [];
  let total = 0;
  for (let f = 0; f < 40; f++) {
    const dir = dirs[f % dirs.length] ?? 'src';
    const name = names[f % names.length] ?? 'File';
    const ext = dir.startsWith('test') ? '.test.tsx' : dir === 'src/hooks' ? '.ts' : '.tsx';
    const file = f === 4 ? 'src/hooks/useAuth.ts' : `${dir}/${name}${f >= names.length ? 'V2' : ''}${ext}`;
    const matches = f === 4 ? 40 : 6 + Math.floor(rand() * 14);
    let line = 1 + Math.floor(rand() * 5);
    for (let m = 0; m < matches; m++) {
      const text = m === 0 && f !== 4 ? RG_TEXTS[0] : RG_TEXTS[1 + Math.floor(rand() * (RG_TEXTS.length - 1))];
      out.push(`${file}:${line}:${text ?? ''}`);
      line += 1 + Math.floor(rand() * 9);
      total++;
    }
  }
  if (total < 450) throw new Error(`rg fixture too small: ${total}`);
  return `${out.join('\n')}\n`;
}

/** `git ls-files` of a monorepo (~400 paths). */
export function lsFiles(): string {
  const out: string[] = ['.editorconfig', '.gitignore', '.github/workflows/ci.yml', '.github/workflows/release.yml', 'README.md', 'package.json', 'pnpm-lock.yaml', 'tsconfig.base.json'];
  const pkgs = ['api', 'web', 'worker', 'shared'];
  const areas = ['routes', 'services', 'models', 'utils', 'components', 'hooks', 'jobs'];
  const rand = rng(99);
  for (const pkg of pkgs) {
    out.push(`packages/${pkg}/package.json`, `packages/${pkg}/tsconfig.json`, `packages/${pkg}/README.md`);
    for (const area of areas) {
      const n = 6 + Math.floor(rand() * 14);
      const ext = pkg === 'web' && (area === 'components' || area === 'hooks') ? '.tsx' : '.ts';
      for (let k = 0; k < n; k++) out.push(`packages/${pkg}/src/${area}/${area.slice(0, -1)}${k + 1}${ext}`);
      out.push(`packages/${pkg}/test/${area}/${area.slice(0, -1)}.test.ts`);
    }
  }
  for (let k = 0; k < 12; k++) out.push(`docs/guides/guide-${k + 1}.md`);
  out.push('docs/images/architecture.png', 'docs/images/deploy-flow.svg', 'scripts/release.mjs', 'scripts/seed-db.ts');
  return `${out.join('\n')}\n`;
}

/** A package-lock.json diff with `count` changed packages. */
function lockfileDiff(count: number): string {
  const rand = rng(1234);
  const out = [
    'diff --git a/package-lock.json b/package-lock.json',
    'index 8e1f0c2..b77d9a3 100644',
    '--- a/package-lock.json',
    '+++ b/package-lock.json',
    '@@ -1,6 +1,6 @@',
    ' {',
    '   "name": "shop-web",',
    '-  "version": "1.4.0",',
    '+  "version": "1.4.1",',
    '   "lockfileVersion": 3,',
    '   "requires": true,',
    '   "packages": {',
  ];
  const names = ['@babel/core', '@babel/parser', '@babel/types', 'esbuild', 'rollup', 'postcss', 'vite', 'react-router', 'react-router-dom', '@remix-run/router', 'caniuse-lite', 'electron-to-chromium', 'browserslist', 'undici-types', '@types/node', 'typescript', 'semver', 'debug', 'ms', 'picocolors'];
  let at = 140;
  for (let k = 0; k < count; k++) {
    const name = `${names[k % names.length] ?? 'pkg'}${k >= names.length ? `-${k}` : ''}`;
    const base = name.split('/').pop() ?? name;
    const v1 = `${1 + (k % 7)}.${Math.floor(rand() * 20)}.${Math.floor(rand() * 9)}`;
    const v2 = v1.replace(/\d+$/, (d) => String(Number(d) + 1));
    out.push(
      `@@ -${at},7 +${at},7 @@`,
      `     "node_modules/${name}": {`,
      `-      "version": "${v1}",`,
      `-      "resolved": "https://registry.npmjs.org/${name}/-/${base}-${v1}.tgz",`,
      `-      "integrity": "sha512-${b64(rand, 86)}",`,
      `+      "version": "${v2}",`,
      `+      "resolved": "https://registry.npmjs.org/${name}/-/${base}-${v2}.tgz",`,
      `+      "integrity": "sha512-${b64(rand, 86)}",`,
      '       "dev": true,',
      '       "dependencies": {',
      `         "debug": "^4.3.${Math.floor(rand() * 5)}"`,
    );
    at += 40 + Math.floor(rand() * 60);
  }
  return out.join('\n');
}

/** Source changes + a large lockfile change + a test change + a minified bundle. */
export function gitDiff(): string {
  const src = fixture('git-diff-src.txt').trimEnd();
  const tests = fixture('git-diff-tests.txt').trimEnd();
  return `${src}\n${lockfileDiff(60)}\n${tests}\n`;
}

/** Pretty-printed API response with `n` items, error details and a 23-digit id. */
export function apiResponse(n: number): string {
  const rand = rng(5);
  const statuses = ['active', 'active', 'active', 'inactive', 'pending'];
  const data = Array.from({ length: n }, (_, i) => ({
    id: i + 1,
    sku: `SKU-${String(100000 + i)}`,
    name: `Product ${i + 1}`,
    price: { amount: Math.round(rand() * 10000) / 100, currency: 'EUR' },
    tags: ['catalog', i % 3 === 0 ? 'featured' : 'regular'],
    status: i === 1234 ? 'failed' : (statuses[i % statuses.length] ?? 'active'),
    updatedAt: new Date(Date.UTC(2024, 0, 1) + i * 60000).toISOString(),
  }));
  const body = {
    status: 'partial',
    requestId: 'TRACE_PLACEHOLDER',
    errors: [
      { code: 'E_RATE_LIMIT', message: 'Rate limit exceeded for /v2/products; retry after 30s' },
      { code: 'E_UPSTREAM_TIMEOUT', message: 'Inventory service timed out after 5000ms (2 of 12 shards missing)' },
    ],
    meta: { page: 1, perPage: n, total: n + 87, next: '/v2/products?page=2' },
    data,
  };
  return `${JSON.stringify(body, null, 2).replace('"TRACE_PLACEHOLDER"', '12345678901234567890123')}\n`;
}

/** ~`bytes` of application log: repeated request lines, unique lines and a few errors. */
export function bigLog(bytes: number): string {
  const rand = rng(2024);
  const out: string[] = [];
  let size = 0;
  let i = 0;
  const paths = ['/api/products', '/api/cart', '/api/orders', '/healthz', '/api/search'];
  while (size < bytes) {
    const ts = new Date(Date.UTC(2024, 4, 1) + i * 37).toISOString();
    let line: string;
    if (i % 50000 === 25000) {
      line = `${ts} ERROR [worker-${i % 8}] payment capture failed for order ${100000 + i}: ECONNRESET`;
    } else if (i % 997 === 0) {
      line = `${ts} INFO  [scheduler] job sync-inventory-${i} finished in ${Math.floor(rand() * 900)}ms`;
    } else {
      const p = paths[i % paths.length] ?? '/';
      line = `${ts} INFO  [http] GET ${p}?page=${i % 40} 200 ${Math.floor(rand() * 300)}ms req=${hex(rand, 16)}`;
    }
    out.push(line);
    size += line.length + 1;
    i++;
  }
  return `${out.join('\n')}\n`;
}
