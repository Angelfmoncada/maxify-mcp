import { describe, expect, it } from 'vitest';
import {
  UsageError,
  booleanOption,
  enumOption,
  integerOption,
  listOption,
  parseCommandOptions,
  rejectPositionals,
  requireOnePositional,
  requirePositionals,
  splitCommandLine,
  stringOption,
} from '../../src/cli/args.js';

describe('splitCommandLine', () => {
  it('finds the command and leaves the other arguments in order', () => {
    const split = splitCommandLine(['query', 'fix', 'login', '--budget', '2000']);
    expect(split.command).toBe('query');
    expect(split.rest).toEqual(['fix', 'login', '--budget', '2000']);
  });

  it('skips global options and their values before the command', () => {
    const split = splitCommandLine(['--root', 'C:\\proj', '--json', '-q', 'index', '--full']);
    expect(split.command).toBe('index');
    expect(split.rest).toEqual(['--root', 'C:\\proj', '--json', '-q', '--full']);
    expect(split.globals).toMatchObject({ root: 'C:\\proj', json: true, quiet: true });
  });

  it('accepts --option=value for globals', () => {
    const split = splitCommandLine(['--state-dir=/tmp/s', 'stats']);
    expect(split.command).toBe('stats');
    expect(split.globals.stateDir).toBe('/tmp/s');
  });

  it('reports no command when only options are present', () => {
    expect(splitCommandLine(['--version']).command).toBeUndefined();
    expect(splitCommandLine(['--version']).globals.version).toBe(true);
    expect(splitCommandLine(['-h']).globals.help).toBe(true);
  });

  it('treats the argument after -- as the command', () => {
    expect(splitCommandLine(['--', 'query']).command).toBe('query');
  });

  it('defers value checks to the strict parse of the chosen command', () => {
    expect(splitCommandLine(['query', '--root']).command).toBe('query');
    expect(() => parseCommandOptions(['--root'], {})).toThrow(UsageError);
  });
});

describe('parseCommandOptions', () => {
  const options = {
    budget: { type: 'string' },
    focus: { type: 'string', multiple: true },
    'no-tests': { type: 'boolean' },
  } as const;

  it('merges global and command options', () => {
    const parsed = parseCommandOptions(['fix', 'it', '--budget', '900', '--json', '--no-tests', '--root', 'r'], options);
    expect(parsed.positionals).toEqual(['fix', 'it']);
    expect(parsed.values.budget).toBe('900');
    expect(parsed.values['no-tests']).toBe(true);
    expect(parsed.globals).toMatchObject({ json: true, root: 'r', quiet: false, help: false, version: false });
  });

  it('collects repeated options', () => {
    const parsed = parseCommandOptions(['--focus', 'a', '--focus', 'b,c'], options);
    expect(parsed.values.focus).toEqual(['a', 'b,c']);
  });

  it('rejects unknown options with a short message', () => {
    expect.assertions(3);
    try {
      parseCommandOptions(['--nope'], options);
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(UsageError);
      expect((error as UsageError).message).toContain("Unknown option '--nope'");
      expect((error as UsageError).message).not.toContain('To specify a positional');
    }
  });

  it('rejects an option that is missing its value', () => {
    expect(() => parseCommandOptions(['--budget'], options)).toThrow(UsageError);
  });

  it('rejects options of other commands', () => {
    expect(() => parseCommandOptions(['--full'], options)).toThrow(UsageError);
  });
});

describe('option accessors', () => {
  it('stringOption returns strings, the last of repeated values, and undefined otherwise', () => {
    expect(stringOption({ a: 'x' }, 'a')).toBe('x');
    expect(stringOption({ a: ['x', 'y'] }, 'a')).toBe('y');
    expect(stringOption({ a: true }, 'a')).toBeUndefined();
    expect(stringOption({}, 'a')).toBeUndefined();
    expect(stringOption({ a: [true] }, 'a')).toBeUndefined();
  });

  it('booleanOption is true only for set flags', () => {
    expect(booleanOption({ a: true }, 'a')).toBe(true);
    expect(booleanOption({ a: 'true' }, 'a')).toBe(false);
    expect(booleanOption({}, 'a')).toBe(false);
  });

  describe('integerOption', () => {
    const range = { min: 1, max: 10 };
    it('parses integers in range', () => {
      expect(integerOption({ n: '5' }, 'n', range)).toBe(5);
      expect(integerOption({ n: '1' }, 'n', range)).toBe(1);
      expect(integerOption({ n: ' 10 ' }, 'n', range)).toBe(10);
      expect(integerOption({}, 'n', range)).toBeUndefined();
    });
    it.each(['0', '11', '-3', '2.5', 'abc', '', '1e3', '99999999999999999999'])('rejects %j', (raw) => {
      expect(() => integerOption({ n: raw }, 'n', range)).toThrow(/--n must be an integer from 1 to 10/);
    });
  });

  it('enumOption accepts members and rejects the rest', () => {
    expect(enumOption({ k: 'log' }, 'k', ['log', 'test'] as const)).toBe('log');
    expect(enumOption({}, 'k', ['log'] as const)).toBeUndefined();
    expect(() => enumOption({ k: 'yaml' }, 'k', ['log', 'test'] as const)).toThrow(/one of log, test \(got "yaml"\)/);
  });

  it('listOption splits commas, merges repeats, trims and drops empties', () => {
    expect(listOption({ f: 'a, b ,,c' }, 'f')).toEqual(['a', 'b', 'c']);
    expect(listOption({ f: ['a', 'b,c'] }, 'f')).toEqual(['a', 'b', 'c']);
    expect(listOption({ f: ' , ' }, 'f')).toBeUndefined();
    expect(listOption({}, 'f')).toBeUndefined();
    expect(listOption({ f: true }, 'f')).toBeUndefined();
  });
});

describe('positional helpers', () => {
  it('requirePositionals enforces presence and maximum', () => {
    expect(requirePositionals(['a', 'b'], 'x')).toEqual(['a', 'b']);
    expect(() => requirePositionals([], 'task')).toThrow('missing task');
    expect(() => requirePositionals(['a', 'b'], 'ref', 1)).toThrow(/at most 1 ref, got 2/);
  });

  it('requireOnePositional returns exactly one argument', () => {
    expect(requireOnePositional(['src/a.ts'], 'ref')).toBe('src/a.ts');
    expect(() => requireOnePositional([], 'ref')).toThrow(UsageError);
    expect(() => requireOnePositional(['a', 'b'], 'ref')).toThrow(UsageError);
  });

  it('rejectPositionals names the stray argument', () => {
    expect(() => rejectPositionals([])).not.toThrow();
    expect(() => rejectPositionals(['oops'])).toThrow('unexpected argument "oops"');
  });
});

describe('UsageError', () => {
  it('remembers the command once and keeps the first one', () => {
    const plain = new UsageError('bad');
    expect(plain.command).toBeUndefined();
    const forQuery = plain.forCommand('query');
    expect(forQuery.command).toBe('query');
    expect(forQuery.message).toBe('bad');
    expect(forQuery.forCommand('other')).toBe(forQuery);
  });
});
