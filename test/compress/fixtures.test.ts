import { describe, expect, it } from 'vitest';
import { compress } from '../../src/compress/index.js';
import type { CompressKind, CompressResult, TransformClass } from '../../src/compress/types.js';
import { checkMarkers, dockerBuildLog, fixture, gitDiff, lsFiles, rgOutput, uncoveredLines } from './helpers.js';

interface Case {
  name: string;
  input: () => string;
  kind: CompressKind;
  transforms: readonly TransformClass[];
  /** estOutputTokens / estOriginalTokens must stay at or below this. */
  maxRatio: number;
  /** Lines (after ANSI/trailing-space cleaning) that must appear verbatim. */
  mustKeep: readonly string[];
  /** Expected start of the first body line when failures exist. */
  firstLine?: string;
}

const CASES: readonly Case[] = [
  {
    name: 'vitest failure run',
    input: () => fixture('vitest-fail.txt'),
    kind: 'test',
    transforms: ['summary'],
    maxRatio: 0.45,
    firstLine: 'summary: FAILED — 2 failed, 68 passed',
    mustKeep: [
      ' FAIL  src/domain/checkout.test.ts > checkout > applies fixed coupon after tax',
      'AssertionError: expected 107.5 to be 105 // Object.is equality',
      "AssertionError: expected { amount: +0, currency: 'EUR' } to deeply equal { amount: 12.9, currency: 'EUR' }",
      '- 105',
      '+ 107.5',
      '-   "amount": 12.9,',
      '+   "amount": 0,',
      ' × src/domain/checkout.test.ts > checkout > applies fixed coupon after tax 8ms',
      '   → expected 107.5 to be 105 // Object.is equality',
      ' ❯ src/domain/checkout.test.ts:58:34',
      '     58|     expect(order.total.amount).toBe(105);',
      ' Test Files  1 failed | 11 passed (12)',
      '      Tests  2 failed | 68 passed (70)',
    ],
  },
  {
    name: 'jest failure with ANSI colors',
    input: () => fixture('jest-fail.txt'),
    kind: 'test',
    transforms: ['summary'],
    maxRatio: 0.65,
    firstLine: 'summary: FAILED — 2 failed, 41 passed, 43 total',
    mustKeep: [
      ' FAIL  src/cart/__tests__/cart.test.js',
      '  ● Cart › removes an item by id',
      '  ● Cart › computes total with discount',
      '    Expected length: 1',
      '    Received length: 2',
      '    > 42 |     expect(cart.items).toHaveLength(1);',
      '    Expected: 90',
      '    Received: 100',
      '      at Object.toBe (src/cart/__tests__/cart.test.js:52:26)',
      '    ✕ removes an item by id (6 ms)',
      'Tests:       2 failed, 41 passed, 43 total',
      'Test Suites: 1 failed, 8 passed, 9 total',
    ],
  },
  {
    name: 'mocha spec reporter',
    input: () => fixture('mocha-fail.txt'),
    kind: 'test',
    transforms: ['summary'],
    maxRatio: 0.85,
    firstLine: 'summary: FAILED — 2 failed, 23 passed',
    mustKeep: [
      '      1) assigns the default role',
      '      AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:',
      "'guest' !== 'member'",
      "      -'guest'",
      "      +'member'",
      '      at Context.<anonymous> (test/user-service.spec.js:58:14)',
      '     Error: Timeout of 2000ms exceeded. For async tests and hooks, ensure "done()" is called; if returning a Promise, ensure it resolves. (/home/dev/users-service/test/user-service.spec.js)',
      '  23 passing (1s)',
      '  2 failing',
    ],
  },
  {
    name: 'node:test spec reporter',
    input: () => fixture('node-test-spec.txt'),
    kind: 'test',
    transforms: ['summary'],
    maxRatio: 0.65,
    firstLine: 'summary: FAILED — 1 failed, 16 passed',
    mustKeep: [
      '  ✖ rejects unknown keys (1.92ms)',
      '    AssertionError [ERR_ASSERTION]: Missing expected exception (ConfigError).',
      '        at TestContext.<anonymous> (file:///home/dev/cli/test/config.test.js:41:12)',
      "      code: 'ERR_ASSERTION',",
      'ℹ fail 1',
      'ℹ pass 16',
    ],
  },
  {
    name: 'node:test TAP reporter',
    input: () => fixture('node-test-tap.txt'),
    kind: 'test',
    transforms: ['summary'],
    maxRatio: 0.65,
    firstLine: 'summary: FAILED — 1 failed, 13 passed',
    mustKeep: [
      '    not ok 4 - rejects unknown keys',
      "      error: 'Missing expected exception (ConfigError).'",
      "      location: '/home/dev/cli/test/config.test.js:38:3'",
      'not ok 1 - parseConfig',
      '# fail 1',
      '# pass 13',
    ],
  },
  {
    name: 'pytest failures and errors',
    input: () => fixture('pytest-fail.txt'),
    kind: 'test',
    transforms: ['summary'],
    maxRatio: 0.85,
    firstLine: 'summary: FAILED — 1 failed, 1 error, 212 passed',
    mustKeep: [
      '>       assert invoice.total == Decimal("72.56")',
      "E       AssertionError: assert Decimal('72.57') == Decimal('72.56')",
      "E           KeyError: 'STRIPE_TEST_KEY'",
      'tests/test_invoices.py:88: AssertionError',
      "FAILED tests/test_invoices.py::test_invoice_total_rounding - AssertionError: assert Decimal('72.57') == Decimal('72.56')",
      "ERROR tests/test_refunds.py::test_partial_refund - KeyError: 'STRIPE_TEST_KEY'",
      '============== 1 failed, 212 passed, 1 warning, 1 error in 3.42s ===============',
    ],
  },
  {
    name: 'go test -v with a panic',
    input: () => fixture('go-test-fail.txt'),
    kind: 'test',
    transforms: ['summary'],
    maxRatio: 0.75,
    firstLine: 'summary: FAILED — 2 failed',
    mustKeep: [
      '    limiter_test.go:47: Allow() at t=1.5s = false; want true',
      '    limiter_test.go:52: tokens left = 0; want 1',
      '--- FAIL: TestRateLimiter_Allow (0.00s)',
      '--- FAIL: TestCache_Evict (0.00s)',
      'panic: runtime error: index out of range [3] with length 3 [recovered]',
      '\t/home/dev/gateway/internal/cache/lru.go:88',
      'exit status 2',
      'FAIL\tgithub.com/acme/gateway/internal/cache\t0.011s',
      'FAIL\tgithub.com/acme/gateway/internal/ratelimit\t0.302s',
    ],
  },
  {
    name: 'playwright list reporter',
    input: () => fixture('playwright-fail.txt'),
    kind: 'test',
    transforms: ['summary'],
    maxRatio: 0.65,
    firstLine: 'summary: FAILED — 1 failed, 22 passed, 1 flaky',
    mustKeep: [
      '  ✘   6 [chromium] › tests/checkout/payment.spec.ts:22:7 › payment › completes purchase with saved card (12.3s)',
      '    Error: Timed out 10000ms waiting for expect(locator).toBeVisible()',
      '    Expected: visible',
      '    Received: <element(s) not found>',
      "    > 30 |     await expect(page.getByRole('heading', { name: 'Order confirmed' })).toBeVisible({ timeout: 10_000 });",
      '        at /home/dev/storefront/tests/checkout/payment.spec.ts:30:74',
      '  1 failed',
      '  1 flaky',
      '  22 passed (48.2s)',
    ],
  },
  {
    name: 'eslint stylish output',
    input: () => fixture('eslint.txt'),
    kind: 'text',
    transforms: ['summary', 'selection'],
    maxRatio: 0.85,
    firstLine: 'summary: failure markers found: 6 lines',
    mustKeep: [
      '/home/dev/shop-web/src/api/client.ts',
      "   14:7   error    'response' is assigned a value but never used                          @typescript-eslint/no-unused-vars",
      '   52:19  error    Unsafe argument of type `any` assigned to a parameter of type `string`  @typescript-eslint/no-unsafe-argument',
      '/home/dev/shop-web/src/components/Cart.tsx',
      '   73:15  error    Do not nest ternary expressions                                        no-nested-ternary',
      '/home/dev/shop-web/src/hooks/useOrders.ts',
      '   40:3   error    Promises must be awaited, end with a call to .catch, or end with a call to .then with a rejection handler  @typescript-eslint/no-floating-promises',
      '/home/dev/shop-web/src/utils/money.ts',
      '   19:10  error    Unnecessary conditional, the types have no overlap                     @typescript-eslint/no-unnecessary-condition',
      '✖ 33 problems (6 errors, 27 warnings)',
    ],
  },
  {
    name: 'webpack build failure',
    input: () => fixture('webpack-build.txt'),
    kind: 'text',
    transforms: ['summary', 'selection'],
    maxRatio: 0.65,
    firstLine: 'summary: failure markers found',
    mustKeep: [
      'ERROR in ./src/components/Checkout/PaymentForm.tsx 42:18',
      'Module parse failed: Unexpected token (42:18)',
      'ERROR in ./src/pages/Orders.tsx 6:0-46',
      "Module not found: Error: Can't resolve '@/hooks/useOrders' in '/home/dev/admin-ui/src/pages'",
      'webpack 5.91.0 compiled with 2 errors and 2 warnings in 8423 ms',
    ],
  },
  {
    name: 'vite build (success with a size warning)',
    input: () => fixture('vite-build.txt'),
    kind: 'text',
    transforms: ['selection', 'summary'],
    maxRatio: 0.6,
    mustKeep: ['✓ built in 6.71s', 'vite v5.2.8 building for production...'],
  },
  {
    name: 'docker build with thousands of progress lines',
    input: dockerBuildLog,
    kind: 'text',
    transforms: ['summary'],
    maxRatio: 0.02,
    firstLine: 'summary: failure markers found',
    mustKeep: [
      '#10 4.113 x Build failed in 2.71s',
      '#10 4.114 /app/src/pages/Checkout.tsx:88:12: ERROR: Expected ")" but found "}"',
      '#10 ERROR: process "/bin/sh -c npm run build" did not complete successfully: exit code: 1',
      'ERROR: failed to solve: process "/bin/sh -c npm run build" did not complete successfully: exit code: 1',
    ],
  },
  {
    name: 'git diff with a lockfile and a minified bundle',
    input: gitDiff,
    kind: 'diff',
    transforms: ['selection'],
    maxRatio: 0.1,
    mustKeep: [
      '@@ -38,12 +39,17 @@ export class Cart {',
      '-    this.items = this.items.filter((item) => item.id === id);',
      '+    this.items = this.items.filter((item) => item.id !== id);',
      '+    return roundMoney(subtotal * (1 - this.percentOff / 100));',
      '+export function roundMoney(amount) {',
      "+  test('ignores a discount code applied twice', () => {",
    ],
  },
  {
    name: 'rg output (~460 matches in 40 files)',
    input: rgOutput,
    kind: 'search',
    transforms: ['selection'],
    maxRatio: 0.1,
    mustKeep: [],
  },
  {
    name: 'git ls-files listing',
    input: lsFiles,
    kind: 'list',
    transforms: ['summary'],
    maxRatio: 0.3,
    mustKeep: [],
  },
];

function bodyLines(r: CompressResult): Set<string> {
  return new Set(r.text.split('\n'));
}

describe('compress() on realistic fixtures', () => {
  for (const c of CASES) {
    describe(c.name, () => {
      const input = c.input();
      const r = compress(input);

      it(`detects kind ${c.kind} and applies ${c.transforms.join('/')}`, () => {
        expect(r.kind).toBe(c.kind);
        expect(c.transforms).toContain(r.transform);
        expect(r.fellBack).toBe(false);
      });

      it(`reduces size to <= ${Math.round(c.maxRatio * 100)}% within the budget`, () => {
        expect(r.stats.estOriginalTokens).toBeGreaterThan(400);
        expect(r.stats.estOutputTokens / r.stats.estOriginalTokens).toBeLessThanOrEqual(c.maxRatio);
        expect(r.stats.estOutputTokens).toBeLessThanOrEqual(1200);
      });

      it('keeps every critical line verbatim', () => {
        const lines = bodyLines(r);
        for (const want of c.mustKeep) expect(lines.has(want), want).toBe(true);
        expect(r.complete).toBe(true);
        expect(r.stats.criticalKept).toBe(r.stats.criticalLines);
      });

      it('points every marker at the right original lines', () => {
        const report = checkMarkers(input, r.text, { trim: c.kind !== 'diff' });
        expect(report.errors).toEqual([]);
        if (c.kind !== 'search') expect(report.checked).toBeGreaterThan(0);
      });

      it('accounts for every original line (no silent omission)', () => {
        expect(uncoveredLines(input, r.text)).toEqual([]);
      });

      if (c.firstLine !== undefined) {
        const first = c.firstLine;
        it('states the failure first and never claims success', () => {
          expect(r.text.split('\n')[0]?.startsWith(first)).toBe(true);
          expect(r.text).not.toMatch(/^summary: PASSED/m);
        });
      }

      it('is deterministic', () => {
        expect(compress(input)).toEqual(r);
      });
    });
  }
});
