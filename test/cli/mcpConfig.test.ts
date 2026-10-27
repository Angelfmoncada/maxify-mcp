import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MaxifyError } from '../../src/core/errors.js';
import {
  MAX_CONFIG_BYTES,
  buildServerEntry,
  entryScriptPath,
  mcpServerEntryOf,
  mergeMcpConfig,
  readJsonFile,
  writeJsonFile,
  type McpServerEntry,
} from '../../src/cli/mcpConfig.js';

const ENTRY: McpServerEntry = { type: 'stdio', command: 'node', args: ['/opt/maxify/dist/cli.js', 'serve'] };

describe('buildServerEntry', () => {
  it('is portable by default: no --root, so the server follows CLAUDE_PROJECT_DIR', () => {
    expect(buildServerEntry({ cliPath: '/opt/maxify/dist/cli.js' })).toEqual(ENTRY);
  });

  it('pins the root when asked', () => {
    expect(buildServerEntry({ cliPath: '/opt/maxify/dist/cli.js', root: '/work/app' }).args).toEqual([
      '/opt/maxify/dist/cli.js',
      'serve',
      '--root',
      '/work/app',
    ]);
  });

  it('allows a custom node command', () => {
    expect(buildServerEntry({ cliPath: 'x.js', nodeCommand: '/usr/bin/node' }).command).toBe('/usr/bin/node');
  });
});

describe('mergeMcpConfig', () => {
  it('creates the document when there is no file', () => {
    expect(mergeMcpConfig(undefined, ENTRY, false)).toEqual({
      kind: 'created',
      config: { mcpServers: { maxify: ENTRY } },
    });
    expect(mergeMcpConfig(null, ENTRY, false).kind).toBe('created');
  });

  it('adds maxify next to other servers without touching them', () => {
    const other = { type: 'http', url: 'https://example.test/mcp' };
    const existing = { mcpServers: { docs: other }, somethingElse: [1, 2] };
    const result = mergeMcpConfig(existing, ENTRY, false);
    expect(result.kind).toBe('added');
    if (result.kind !== 'added') return;
    expect(result.config).toEqual({ mcpServers: { docs: other, maxify: ENTRY }, somethingElse: [1, 2] });
    expect(Object.keys(result.config.mcpServers as object)).toEqual(['docs', 'maxify']);
  });

  it('adds mcpServers when the file has none', () => {
    const result = mergeMcpConfig({ $schema: 'x' }, ENTRY, false);
    expect(result).toEqual({ kind: 'added', config: { $schema: 'x', mcpServers: { maxify: ENTRY } } });
  });

  it('leaves an identical entry alone, whatever the key order', () => {
    const reordered = { args: ENTRY.args, command: 'node', type: 'stdio' };
    const existing = { mcpServers: { maxify: reordered } };
    const result = mergeMcpConfig(existing, ENTRY, false);
    expect(result.kind).toBe('unchanged');
    if (result.kind === 'unchanged') expect(result.config).toBe(existing);
  });

  it('refuses to replace a different maxify entry without --force', () => {
    const different = { type: 'stdio', command: 'npx', args: ['maxify-mcp', 'serve'] };
    const existing = { mcpServers: { maxify: different, docs: { type: 'http', url: 'u' } } };
    const result = mergeMcpConfig(existing, ENTRY, false);
    expect(result.kind).toBe('conflict');
    if (result.kind !== 'conflict') return;
    expect(result.current).toEqual(different);
    expect(result.config).toBe(existing);
  });

  it('replaces a different entry with --force, keeping the other servers and the entry position', () => {
    const different = { type: 'stdio', command: 'npx', args: ['maxify-mcp'] };
    const docs = { type: 'http', url: 'u' };
    const existing = { mcpServers: { maxify: different, docs } };
    const result = mergeMcpConfig(existing, ENTRY, true);
    expect(result.kind).toBe('replaced');
    if (result.kind !== 'replaced') return;
    expect(result.config).toEqual({ mcpServers: { maxify: ENTRY, docs } });
    expect(Object.keys(result.config.mcpServers as object)).toEqual(['maxify', 'docs']);
  });

  it('treats a pinned-root entry as different from the portable one', () => {
    const pinned = buildServerEntry({ cliPath: '/opt/maxify/dist/cli.js', root: '/work/app' });
    expect(mergeMcpConfig({ mcpServers: { maxify: pinned } }, ENTRY, false).kind).toBe('conflict');
  });

  it.each([
    ['an array', []],
    ['a string', 'hello'],
    ['a number', 7],
  ])('rejects %s at the top level', (_label, existing) => {
    const result = mergeMcpConfig(existing, ENTRY, true);
    expect(result.kind).toBe('invalid');
  });

  it('rejects an mcpServers value that is not an object', () => {
    expect(mergeMcpConfig({ mcpServers: [] }, ENTRY, true).kind).toBe('invalid');
    expect(mergeMcpConfig({ mcpServers: 'x' }, ENTRY, true).kind).toBe('invalid');
  });

  it('never mutates its input', () => {
    const existing = { mcpServers: { docs: { type: 'http', url: 'u' } } };
    const snapshot = JSON.stringify(existing);
    mergeMcpConfig(existing, ENTRY, false);
    mergeMcpConfig(existing, ENTRY, true);
    expect(JSON.stringify(existing)).toBe(snapshot);
  });
});

describe('entry helpers', () => {
  it('mcpServerEntryOf reads the maxify entry defensively', () => {
    expect(mcpServerEntryOf({ mcpServers: { maxify: ENTRY } })).toEqual(ENTRY);
    expect(mcpServerEntryOf({ mcpServers: {} })).toBeUndefined();
    expect(mcpServerEntryOf({ mcpServers: 'x' })).toBeUndefined();
    expect(mcpServerEntryOf(null)).toBeUndefined();
    expect(mcpServerEntryOf([])).toBeUndefined();
  });

  it('entryScriptPath finds the .js argument', () => {
    expect(entryScriptPath(ENTRY)).toBe('/opt/maxify/dist/cli.js');
    expect(entryScriptPath({ command: 'node', args: ['--no-warnings', 'C:\\x\\cli.mjs', 'serve'] })).toBe('C:\\x\\cli.mjs');
    expect(entryScriptPath({ command: 'npx', args: ['maxify-mcp', 'serve'] })).toBeUndefined();
    expect(entryScriptPath({ command: 'x' })).toBeUndefined();
    expect(entryScriptPath('nope')).toBeUndefined();
  });
});

describe('file helpers', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'maxify-mcpcfg-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('readJsonFile distinguishes missing, valid and invalid files', () => {
    const file = path.join(dir, '.mcp.json');
    expect(readJsonFile(file)).toEqual({ kind: 'missing' });
    writeFileSync(file, '{"a":1}');
    expect(readJsonFile(file)).toEqual({ kind: 'ok', value: { a: 1 } });
    writeFileSync(file, '{oops');
    const bad = readJsonFile(file);
    expect(bad.kind).toBe('invalid-json');
  });

  describe('readJsonFile refuses what a hostile project could use against the user', () => {
    it('does not follow links (a link to a secret file must not be read, then copied by a rewrite)', () => {
      const secret = path.join(dir, 'secret-dir');
      mkdirSync(secret);
      const file = path.join(dir, '.mcp.json');
      try {
        symlinkSync(secret, file, 'junction');
      } catch {
        return; // This machine does not allow creating links.
      }
      const result = readJsonFile(file);
      expect(result.kind).toBe('unsafe');
      if (result.kind === 'unsafe') expect(result.message).toContain('symbolic link');
    });

    it('refuses directories and other non-regular files', () => {
      const file = path.join(dir, 'a-directory');
      mkdirSync(file);
      const result = readJsonFile(file);
      expect(result.kind).toBe('unsafe');
      if (result.kind === 'unsafe') expect(result.message).toContain('not a regular file');
    });

    it('refuses files that are too large to be a config file', () => {
      const file = path.join(dir, 'big.json');
      writeFileSync(file, `{"pad":"${'x'.repeat(MAX_CONFIG_BYTES)}"}`);
      const result = readJsonFile(file);
      expect(result.kind).toBe('unsafe');
      if (result.kind === 'unsafe') expect(result.message).toContain('larger than 1024 KiB');
    });

    it('reads a file just under the limit', () => {
      const file = path.join(dir, 'ok.json');
      writeFileSync(file, `{"pad":"${'x'.repeat(MAX_CONFIG_BYTES - 20)}"}`);
      expect(readJsonFile(file).kind).toBe('ok');
    });
  });

  describe('readJsonFile understands files saved by Windows tools', () => {
    it('strips a UTF-8 byte-order mark (Notepad, PowerShell 5 Out-File)', () => {
      const file = path.join(dir, 'bom.json');
      writeFileSync(file, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"a":1}')]));
      expect(readJsonFile(file)).toEqual({ kind: 'ok', value: { a: 1 } });
    });

    it('decodes UTF-16 with a BOM (PowerShell redirection)', () => {
      const file = path.join(dir, 'utf16.json');
      writeFileSync(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('{"a":"é"}', 'utf16le')]));
      expect(readJsonFile(file)).toEqual({ kind: 'ok', value: { a: 'é' } });
    });
  });

  it.skipIf(process.platform === 'win32')('writeJsonFile keeps the permissions of the file it replaces', () => {
    const file = path.join(dir, '.mcp.json');
    writeFileSync(file, '{}', { mode: 0o600 });
    chmodSync(file, 0o600);
    writeJsonFile(file, { a: 1 });
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('writeJsonFile writes 2-space JSON with a trailing newline and leaves no temp file', () => {
    const file = path.join(dir, '.mcp.json');
    writeJsonFile(file, { mcpServers: { maxify: ENTRY } });
    const text = readFileSync(file, 'utf8');
    expect(text.endsWith('}\n')).toBe(true);
    expect(text).toContain('\n  "mcpServers": {');
    expect(JSON.parse(text)).toEqual({ mcpServers: { maxify: ENTRY } });
    expect(readdirSync(dir)).toEqual(['.mcp.json']);
  });

  it('writeJsonFile replaces an existing file', () => {
    const file = path.join(dir, 'c.json');
    writeJsonFile(file, { a: 1 });
    writeJsonFile(file, { a: 2 });
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ a: 2 });
  });

  it('writeJsonFile replaces a stale temp file left by an earlier crash', () => {
    const file = path.join(dir, 'c.json');
    writeFileSync(path.join(dir, `.c.json.${process.pid}.tmp`), 'garbage');
    writeJsonFile(file, { fresh: true });
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ fresh: true });
    expect(readdirSync(dir)).toEqual(['c.json']);
  });

  it('writeJsonFile reports failures as MaxifyError', () => {
    const file = path.join(dir, 'missing-dir', 'x.json');
    expect(() => writeJsonFile(file, {})).toThrow(MaxifyError);
    expect(existsSync(path.join(dir, 'missing-dir'))).toBe(false);
  });
});
