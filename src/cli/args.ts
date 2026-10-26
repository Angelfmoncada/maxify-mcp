/**
 * Argument parsing on top of node:util parseArgs.
 *
 * Global options may appear before or after the command; command options are
 * validated against the command's own spec. Every user mistake is a UsageError
 * (exit code 2), never a stack trace.
 */
import { parseArgs, type ParseArgsOptionsConfig } from 'node:util';

export class UsageError extends Error {
  /** Command the mistake was made in, so the hint can point at its own help. */
  readonly command: string | undefined;

  constructor(message: string, command?: string) {
    super(message);
    this.name = 'UsageError';
    this.command = command;
  }

  forCommand(command: string): UsageError {
    return this.command === undefined ? new UsageError(this.message, command) : this;
  }
}

export type OptionValue = string | boolean | Array<string | boolean> | undefined;
export type OptionValues = Record<string, OptionValue>;

export const GLOBAL_OPTIONS: ParseArgsOptionsConfig = {
  root: { type: 'string' },
  'state-dir': { type: 'string' },
  config: { type: 'string' },
  quiet: { type: 'boolean', short: 'q' },
  json: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
};

export interface GlobalOptions {
  root: string | undefined;
  stateDir: string | undefined;
  config: string | undefined;
  quiet: boolean;
  json: boolean;
  help: boolean;
  version: boolean;
}

export interface SplitCommandLine {
  /** First positional token (the command), if any. */
  command: string | undefined;
  /** Every other argument, in order. */
  rest: string[];
  /** Global flags seen while looking for the command (non-strict). */
  globals: GlobalOptions;
}

export interface ParsedCommandLine {
  globals: GlobalOptions;
  values: OptionValues;
  positionals: string[];
}

function parseFailure(error: unknown): UsageError {
  const message = error instanceof Error ? error.message : String(error);
  // node's unknown-option text appends a long hint about '--'; the first sentence is enough.
  const [firstSentence = message] = message.split('. To specify a positional argument');
  return new UsageError(firstSentence);
}

export function readGlobals(values: OptionValues): GlobalOptions {
  return {
    root: stringOption(values, 'root'),
    stateDir: stringOption(values, 'state-dir'),
    config: stringOption(values, 'config'),
    quiet: values.quiet === true,
    json: values.json === true,
    help: values.help === true,
    version: values.version === true,
  };
}

/**
 * Find the command: the first positional once global options (and their
 * values) are skipped. Unknown options are tolerated here and validated later
 * against the chosen command.
 */
export function splitCommandLine(argv: readonly string[]): SplitCommandLine {
  const args = [...argv];
  let pre;
  try {
    pre = parseArgs({ args, options: GLOBAL_OPTIONS, strict: false, allowPositionals: true, tokens: true });
  } catch (error: unknown) {
    throw parseFailure(error);
  }
  const commandToken = pre.tokens.find((token) => token.kind === 'positional');
  const rest = commandToken === undefined ? args : args.filter((_, index) => index !== commandToken.index);
  return {
    command: commandToken?.kind === 'positional' ? commandToken.value : undefined,
    rest,
    globals: readGlobals(pre.values as OptionValues),
  };
}

export function parseCommandOptions(rest: readonly string[], commandOptions: ParseArgsOptionsConfig): ParsedCommandLine {
  try {
    const parsed = parseArgs({
      args: [...rest],
      options: { ...GLOBAL_OPTIONS, ...commandOptions },
      strict: true,
      allowPositionals: true,
    });
    const values = parsed.values as OptionValues;
    return { globals: readGlobals(values), values, positionals: parsed.positionals };
  } catch (error: unknown) {
    throw parseFailure(error);
  }
}

export function stringOption(values: OptionValues, name: string): string | undefined {
  const value = values[name];
  if (value === undefined) return undefined;
  if (Array.isArray(value)) {
    const last = value[value.length - 1];
    return typeof last === 'string' ? last : undefined;
  }
  return typeof value === 'string' ? value : undefined;
}

export function booleanOption(values: OptionValues, name: string): boolean {
  return values[name] === true;
}

export function integerOption(
  values: OptionValues,
  name: string,
  range: { min: number; max: number },
): number | undefined {
  const raw = stringOption(values, name);
  if (raw === undefined) return undefined;
  const value = /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : Number.NaN;
  if (!Number.isSafeInteger(value) || value < range.min || value > range.max) {
    throw new UsageError(`--${name} must be an integer from ${range.min} to ${range.max} (got "${raw}")`);
  }
  return value;
}

export function enumOption<T extends string>(
  values: OptionValues,
  name: string,
  allowed: readonly T[],
): T | undefined {
  const raw = stringOption(values, name);
  if (raw === undefined) return undefined;
  const match = allowed.find((candidate) => candidate === raw);
  if (match === undefined) throw new UsageError(`--${name} must be one of ${allowed.join(', ')} (got "${raw}")`);
  return match;
}

/** Comma-separated and/or repeated option -> trimmed, non-empty items. */
export function listOption(values: OptionValues, name: string): string[] | undefined {
  const raw = values[name];
  if (raw === undefined) return undefined;
  const parts = (Array.isArray(raw) ? raw : [raw]).flatMap((entry) => (typeof entry === 'string' ? entry.split(',') : []));
  const items = parts.map((part) => part.trim()).filter((part) => part.length > 0);
  return items.length > 0 ? items : undefined;
}

export function requirePositionals(positionals: readonly string[], what: string, max?: number): string[] {
  if (positionals.length === 0) throw new UsageError(`missing ${what}`);
  if (max !== undefined && positionals.length > max) {
    throw new UsageError(`too many arguments: expected at most ${max} ${what}, got ${positionals.length}`);
  }
  if (positionals.some((value) => value.trim().length === 0)) throw new UsageError(`${what} must not be empty`);
  return [...positionals];
}

/** Exactly one positional argument. */
export function requireOnePositional(positionals: readonly string[], what: string): string {
  const [first] = requirePositionals(positionals, what, 1);
  return first ?? '';
}

export function rejectPositionals(positionals: readonly string[]): void {
  if (positionals.length > 0) throw new UsageError(`unexpected argument "${positionals[0]}"`);
}
