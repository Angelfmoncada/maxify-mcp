import { describe, expect, it } from 'vitest';
import { parseTs, qualNames, src, sym, symbolIndex } from './helpers.js';

describe('typescript adapter: test structure', () => {
  const file = parseTs(
    src(
      "import { describe, it, expect } from 'vitest';", // 1
      "describe('auth', () => {", // 2
      "  it('logs in', async () => {", // 3
      '    expect(await login()).toBe(true);', // 4
      '  });', // 5
      "  describe.each([1, 2])('with %i', (n) => {", // 6
      "    it.only('works', () => {});", // 7
      "    test.each`a${1}`('table', () => {});", // 8
      '  });', // 9
      "  it.skip(`template title`, () => {});", // 10
      "  it.todo('later');", // 11
      '  it(`dynamic ${name}`, () => {});', // 12
      '  it(titleVariable, () => {});', // 13
      "  it.concurrent.each([1])('combo %i', () => {});", // 14
      '});', // 15
      "test.describe.serial('playwright', () => {", // 16
      "  test('step', async ({ page }) => {});", // 17
      "  test.step('not a test', async () => {});", // 18
      '});', // 19
      "suite('mocha', function () { context('ctx', () => { specify('spec', () => {}); }); });", // 20
      "xit('skipped', () => {});", // 21
      "fdescribe('focused', () => {});", // 22
    ),
    'src/auth.test.ts',
  );

  it('marks the file as a test file', () => {
    expect(file.isTest).toBe(true);
  });

  it('builds nested suites and tests with literal titles only', () => {
    expect(qualNames(file)).toEqual([
      'auth',
      'auth > logs in',
      'auth > with %i',
      'auth > with %i > works',
      'auth > with %i > table',
      'auth > template title',
      'auth > later',
      'auth > combo %i',
      'playwright',
      'playwright > step',
      'mocha',
      'mocha > ctx',
      'mocha > ctx > spec',
      'skipped',
      'focused',
    ]);
  });

  it('assigns kinds, names, parents and spans', () => {
    expect(sym(file, 'auth')).toMatchObject({ kind: 'suite', name: 'auth', parent: null, span: { startLine: 2, endLine: 15 } });
    expect(sym(file, 'auth > logs in')).toMatchObject({ kind: 'test', name: 'logs in', parent: symbolIndex(file, 'auth'), span: { startLine: 3, endLine: 5 } });
    expect(sym(file, 'auth > with %i > works').parent).toBe(symbolIndex(file, 'auth > with %i'));
    expect(sym(file, 'playwright').kind).toBe('suite');
    expect(sym(file, 'mocha > ctx').kind).toBe('suite');
    expect(sym(file, 'mocha > ctx > spec').kind).toBe('test');
  });

  it('records modifiers as flags and the callee in the signature', () => {
    expect(sym(file, 'auth > with %i').flags).toEqual(['each']);
    expect(sym(file, 'auth > with %i').signature).toBe("describe.each(…)('with %i')");
    expect(sym(file, 'auth > with %i > works').flags).toEqual(['only']);
    expect(sym(file, 'auth > template title').flags).toEqual(['skip']);
    expect(sym(file, 'auth > template title').signature).toBe('it.skip(`template title`)');
    expect(sym(file, 'auth > later').flags).toEqual(['todo']);
    expect(sym(file, 'auth > combo %i').flags).toEqual(['concurrent', 'each']);
    expect(sym(file, 'playwright').flags).toEqual(['serial']);
    expect(sym(file, 'skipped').flags).toEqual(['skip']);
    expect(sym(file, 'focused').flags).toEqual(['only']);
  });

  it('attributes references inside test bodies to the test', () => {
    const login = file.refs.find((r) => r.target.type === 'import' && r.target.name === 'expect');
    expect(login?.from).toBe(symbolIndex(file, 'auth > logs in'));
  });
});

describe('typescript adapter: tests outside describe blocks', () => {
  it('finds tests registered inside top-level blocks and loops', () => {
    const file = parseTs(
      src(
        'if (import.meta.vitest) {',
        '  const { it } = import.meta.vitest;',
        "  it('in-source', () => {});",
        '}',
        "for (const c of cases) describe('loop', () => {});",
      ),
      'src/math.ts',
    );
    expect(qualNames(file)).toEqual(['block@L1', 'in-source', 'loop']);
    expect(sym(file, 'in-source').parent).toBeNull();
    expect(file.isTest).toBe(false);
  });

  it('ignores calls that only look like tests', () => {
    const file = parseTs(src("regex.test('abc');", "this.it('x');", "describe.configure('x');", 'it();'));
    expect(file.symbols.filter((s) => s.kind === 'test' || s.kind === 'suite')).toEqual([]);
  });
});
