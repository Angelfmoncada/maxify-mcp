// Minimal command-line parser: --flag, --name value, --name=value, comma lists. No dependencies.

export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
  }
}

/**
 * schema: { [name]: { type: 'boolean' | 'string' | 'number' | 'list', default?: unknown } }
 * Returns { values, positionals }. Unknown options and missing values throw UsageError.
 * A list option may be repeated; its values are concatenated.
 */
export function parseArgs(argv, schema) {
  const values = {};
  for (const [name, spec] of Object.entries(schema)) {
    if (spec.default !== undefined) values[name] = spec.default;
  }
  const provided = new Set();
  const positionals = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      positionals.push(token);
      continue;
    }
    const equals = token.indexOf('=');
    const name = token.slice(2, equals < 0 ? undefined : equals);
    const spec = schema[name];
    if (spec === undefined) throw new UsageError(`Unknown option --${name}`);
    if (spec.type === 'boolean') {
      if (equals >= 0) throw new UsageError(`--${name} does not take a value`);
      values[name] = true;
      continue;
    }
    let raw;
    if (equals >= 0) {
      raw = token.slice(equals + 1);
    } else {
      raw = argv[index + 1];
      index += 1;
    }
    if (raw === undefined || (equals < 0 && raw.startsWith('--'))) throw new UsageError(`--${name} needs a value`);
    if (spec.type === 'number') {
      const number = Number(raw);
      if (!Number.isFinite(number)) throw new UsageError(`--${name} must be a number (got "${raw}")`);
      values[name] = number;
    } else if (spec.type === 'list') {
      const items = raw.split(',').map((item) => item.trim()).filter((item) => item.length > 0);
      values[name] = provided.has(name) ? [...values[name], ...items] : items;
    } else {
      values[name] = raw;
    }
    provided.add(name);
  }
  return { values, positionals };
}
