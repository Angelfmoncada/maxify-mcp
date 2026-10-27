import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  checkNode,
  formatCheck,
  indexedFileCount,
  isVersionAtLeast,
  readIndexHealth,
} from '../../src/cli/doctorChecks.js';
import { okOutput } from '../mcp/helpers.js';
import { createHarness, createTempProject, type Harness, type TempProject } from './helpers.js';

/** What the real engine prints for `maxify_stats {scope: 'index'}` (src/engine/stats.ts). */
function statsText(index: { generation: number; lastIndex: string; files: string }): string {
  return [
    'maxify_stats \u00b7 scope index',
    '',
    '## index',
    'root: /repo',
    'state: /state',
    `generation ${index.generation} \u00b7 last index ${index.lastIndex} (812 ms)`,
    `files: ${index.files}`,
    'symbols: function 40, class 3',
    '',
    '## limitations',
    '- Token counts are local heuristic estimates.',
  ].join('\n');
}

const HEALTHY_STATS = statsText({ generation: 3, lastIndex: '2026-10-26T10:00:00.000Z', files: 'ok 120, skipped 3' });

describe('maxify doctor', () => {
  let project: TempProject;
  let cliPath: string;
  let stateDir: string;

  beforeEach(() => {
    project = createTempProject();
    cliPath = path.join(project.dir, 'dist', 'cli.js');
    mkdirSync(path.dirname(cliPath), { recursive: true });
    writeFileSync(cliPath, '// stub cli');
    stateDir = path.join(project.dir, '.state');
  });
  afterEach(() => {
    project.cleanup();
  });

  const register = (entry: unknown = { type: 'stdio', command: 'node', args: [cliPath, 'serve'] }): void => {
    writeFileSync(path.join(project.dir, '.mcp.json'), JSON.stringify({ mcpServers: { maxify: entry } }));
  };
  const harness = (options: Parameters<typeof createHarness>[0] = {}): Harness =>
    createHarness({
      cwd: project.dir,
      cliPath,
      engine: { stats: async () => okOutput(HEALTHY_STATS) },
      ...options,
    });
  const doctor = (h: Harness, ...extra: string[]): Promise<number> => h.run('doctor', '--state-dir', stateDir, ...extra);
  const lineFor = (h: Harness, name: string): string => h.stdout().split('\n').find((line) => line.includes(`${name}:`)) ?? '';

  it('passes every check on a healthy setup', async () => {
    register();
    const h = harness();
    expect(await doctor(h)).toBe(0);
    expect(lineFor(h, 'Node.js')).toMatch(/^PASS {2}Node\.js: \d+\.\d+\.\d+ \(>= 22\.13\.0 required\)/);
    expect(lineFor(h, 'node:sqlite + FTS5')).toMatch(/^PASS/);
    expect(lineFor(h, 'TypeScript Compiler API')).toMatch(/^PASS {2}TypeScript Compiler API: typescript \d+\./);
    expect(lineFor(h, 'Repository root')).toContain(project.dir);
    expect(lineFor(h, 'State directory')).toMatch(/^PASS/);
    expect(lineFor(h, 'Config')).toMatch(/^PASS {2}Config: no maxify\.config\.json; defaults in use/);
    expect(lineFor(h, 'Index')).toBe('PASS  Index: files ok 120, skipped 3; generation 3, last index 2026-10-26T10:00:00.000Z');
    expect(lineFor(h, '.mcp.json')).toContain(`maxify entry points to ${cliPath}`);
    expect(lineFor(h, 'MCP self-test')).toMatch(/^PASS {2}MCP self-test: 6 tools listed \(3 ms\)/);
    expect(lineFor(h, 'Tool surface')).toMatch(/^PASS {2}Tool surface: tool surface: ~\d+ est\. tokens/);
    expect(h.stdout()).toMatch(/\n\d+ passed, 0 warning\(s\), 0 failed\n$/);
    expect(h.stderr()).toBe('');
  });

  it('starts the real server the way Claude Code would: node cli.js serve, with the state dir', async () => {
    register();
    const h = harness({ env: { MAXIFY_HOME: '/elsewhere', UNRELATED: 'x' } });
    await doctor(h);
    expect(h.deps.runMcpSelfTest).toHaveBeenCalledWith({
      command: process.execPath,
      args: [cliPath, 'serve', '--root', project.dir, '--state-dir', stateDir, '--no-index'],
      env: { MAXIFY_HOME: '/elsewhere' },
      cwd: project.dir,
    });
  });

  it('closes its own engine before the self-test starts the server', async () => {
    register();
    const h = harness();
    vi.mocked(h.deps.runMcpSelfTest).mockImplementation(async () => {
      expect(h.fake.engine.close).toHaveBeenCalledTimes(1);
      return { ok: true, message: 'fine', toolNames: [], durationMs: 1 };
    });
    expect(await doctor(h)).toBe(0);
  });

  it('forwards --config to the self-test server', async () => {
    register();
    const config = path.join(project.dir, 'custom.json');
    writeFileSync(config, '{}');
    const h = harness();
    await doctor(h, '--config', config);
    const args = vi.mocked(h.deps.runMcpSelfTest).mock.calls[0]?.[0].args ?? [];
    expect(args.slice(-2)).toEqual(['--config', config]);
    expect(lineFor(h, 'Config')).toContain(`valid (${config})`);
  });

  describe('failures exit 1', () => {
    it('FAIL when the MCP self-test fails', async () => {
      register();
      const h = harness({
        deps: {
          runMcpSelfTest: vi.fn(async () => ({ ok: false, message: 'Connection closed; server stderr: no index', toolNames: [], durationMs: 9 })),
        },
      });
      expect(await doctor(h)).toBe(1);
      expect(lineFor(h, 'MCP self-test')).toBe('FAIL  MCP self-test: Connection closed; server stderr: no index');
      expect(h.stdout()).toMatch(/1 failed\n$/);
    });

    it('FAIL when the engine cannot be opened, and the self-test still runs', async () => {
      register();
      const h = harness({
        deps: {
          openEngine: async () => {
            throw new Error('openEngine is not implemented yet');
          },
        },
      });
      expect(await doctor(h)).toBe(1);
      expect(lineFor(h, 'Index')).toBe('FAIL  Index: cannot open the engine: openEngine is not implemented yet');
      expect(h.deps.runMcpSelfTest).toHaveBeenCalledTimes(1);
    });

    it('FAIL when index stats report an error or throw', async () => {
      register();
      const reported = harness({ engine: { stats: async () => okOutput('index is corrupt\nrun maxify index --full', { isError: true }) } });
      expect(await doctor(reported)).toBe(1);
      expect(lineFor(reported, 'Index')).toBe('FAIL  Index: index is corrupt');
      const thrown = harness({
        engine: {
          stats: async () => {
            throw new Error('no such table: files');
          },
        },
      });
      expect(await doctor(thrown)).toBe(1);
      expect(lineFor(thrown, 'Index')).toBe('FAIL  Index: no such table: files');
    });

    it('FAIL when maxify.config.json is invalid', async () => {
      register();
      writeFileSync(path.join(project.dir, 'maxify.config.json'), '{ "bogus": true }');
      const h = harness();
      expect(await doctor(h)).toBe(1);
      expect(lineFor(h, 'Config')).toMatch(/^FAIL {2}Config: Invalid maxify\.config\.json/);
    });

    it('FAIL when the .mcp.json entry points to a missing cli.js', async () => {
      register({ type: 'stdio', command: 'node', args: [path.join(project.dir, 'gone', 'cli.js'), 'serve'] });
      const h = harness();
      expect(await doctor(h)).toBe(1);
      expect(lineFor(h, '.mcp.json')).toContain('points to a missing file');
      expect(lineFor(h, '.mcp.json')).toContain('maxify init --force');
    });

    it('FAIL when .mcp.json is not valid JSON', async () => {
      writeFileSync(path.join(project.dir, '.mcp.json'), '{ nope');
      const h = harness();
      expect(await doctor(h)).toBe(1);
      expect(lineFor(h, '.mcp.json')).toMatch(/^FAIL {2}\.mcp\.json: .* is not valid JSON/);
    });

    it('FAIL when .mcp.json is far too large to be a config file', async () => {
      writeFileSync(path.join(project.dir, '.mcp.json'), `{"pad":"${'x'.repeat(1024 * 1024)}"}`);
      const h = harness();
      expect(await doctor(h)).toBe(1);
      expect(lineFor(h, '.mcp.json')).toMatch(/^FAIL {2}\.mcp\.json: .* is larger than 1024 KiB/);
    });

    it('FAIL on an unsafe root, and skips the checks that need one', async () => {
      const h = harness();
      expect(await h.run('doctor', '--root', homedir())).toBe(1);
      expect(lineFor(h, 'Repository root')).toMatch(/^FAIL {2}Repository root: Refusing to use/);
      expect(h.stdout()).not.toContain('State directory');
      expect(h.stdout()).not.toContain('MCP self-test');
      expect(h.opened).toHaveLength(0);
      expect(lineFor(h, 'Tool surface')).toMatch(/^PASS/);
    });

    it('FAIL when the state directory is not writable', async () => {
      register();
      const blocker = path.join(project.dir, 'blocker');
      writeFileSync(blocker, 'a file, not a directory');
      const h = harness();
      expect(await h.run('doctor', '--state-dir', path.join(blocker, 'state'))).toBe(1);
      expect(lineFor(h, 'State directory')).toMatch(/^FAIL {2}State directory: .* is not writable/);
    });
  });

  describe('warnings do not fail the run', () => {
    it('WARN when .mcp.json is missing', async () => {
      const h = harness();
      expect(await doctor(h)).toBe(0);
      expect(lineFor(h, '.mcp.json')).toBe('WARN  .mcp.json: not found; run "maxify init" to register the server');
      expect(h.stdout()).toMatch(/1 warning\(s\), 0 failed\n$/);
    });

    it('WARN when .mcp.json has no maxify server', async () => {
      writeFileSync(path.join(project.dir, '.mcp.json'), JSON.stringify({ mcpServers: { docs: { url: 'u' } } }));
      const h = harness();
      expect(await doctor(h)).toBe(0);
      expect(lineFor(h, '.mcp.json')).toBe('WARN  .mcp.json: no "maxify" server; run "maxify init"');
    });

    it('WARN when the entry has no script path to verify (for example npx)', async () => {
      register({ type: 'stdio', command: 'npx', args: ['maxify-mcp', 'serve'] });
      const h = harness();
      expect(await doctor(h)).toBe(0);
      expect(lineFor(h, '.mcp.json')).toMatch(/^WARN {2}\.mcp\.json: maxify entry does not run node/);
    });

    it('does not vouch for an entry that runs something other than node, whatever files exist', async () => {
      register({ type: 'stdio', command: 'sh', args: ['-c', 'echo hi', cliPath, 'serve'] });
      const h = harness();
      expect(await doctor(h)).toBe(0);
      expect(lineFor(h, '.mcp.json')).toMatch(/^WARN {2}\.mcp\.json: maxify entry does not run node \(command "sh"\)/);
    });

    it('recognizes node given as an absolute Windows path', async () => {
      register({ type: 'stdio', command: 'C:\\Program Files\\nodejs\\node.exe', args: [cliPath, 'serve'] });
      const h = harness();
      expect(await doctor(h)).toBe(0);
      expect(lineFor(h, '.mcp.json')).toMatch(/^PASS/);
    });

    it('WARN when the entry runs the script without its serve command', async () => {
      register({ type: 'stdio', command: 'node', args: [cliPath, 'doctor'] });
      const h = harness();
      expect(await doctor(h)).toBe(0);
      expect(lineFor(h, '.mcp.json')).toContain('but not its "serve" command');
    });

    it('does not touch network paths named by the repository', async () => {
      register({ type: 'stdio', command: 'node', args: ['\\\\evil-host\\share\\cli.js', 'serve'] });
      const h = harness();
      expect(await doctor(h)).toBe(0);
      expect(lineFor(h, '.mcp.json')).toMatch(/^WARN {2}\.mcp\.json: maxify entry runs a script on a network path/);
      register({ type: 'stdio', command: 'node', args: ['//evil-host/share/cli.js', 'serve'] });
      const second = harness();
      await doctor(second);
      expect(lineFor(second, '.mcp.json')).toMatch(/^WARN .*network path/);
    });

    it('makes control characters from the repository visible instead of passing them to the terminal', async () => {
      register({ type: 'stdio', command: 'node', args: [path.join(project.dir, 'x\u001b[2Jcli.js'), 'serve'] });
      const h = harness();
      expect(await doctor(h)).toBe(1);
      const escape = String.fromCharCode(27);
      expect(h.stdout()).not.toContain(escape);
      expect(h.stdout()).toContain('\\x1b[2Jcli.js');
    });

    it('accepts a .mcp.json saved with a byte-order mark (Notepad, PowerShell)', async () => {
      const content = JSON.stringify({ mcpServers: { maxify: { type: 'stdio', command: 'node', args: [cliPath, 'serve'] } } });
      writeFileSync(path.join(project.dir, '.mcp.json'), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(content)]));
      const h = harness();
      expect(await doctor(h)).toBe(0);
      expect(lineFor(h, '.mcp.json')).toMatch(/^PASS/);
    });

    it('FAIL (not follow) when .mcp.json is a link', async () => {
      const target = path.join(project.dir, 'elsewhere');
      mkdirSync(target);
      try {
        // A directory link: creatable without special privileges on Windows, and reported as a symlink.
        symlinkSync(target, path.join(project.dir, '.mcp.json'), 'junction');
      } catch {
        return; // This machine does not allow creating links at all.
      }
      const h = harness();
      expect(await doctor(h)).toBe(1);
      expect(lineFor(h, '.mcp.json')).toMatch(/^FAIL {2}\.mcp\.json: .* is a symbolic link/);
    });

    it('WARN when nothing is indexed yet', async () => {
      register();
      const never = statsText({ generation: 0, lastIndex: 'never', files: 'none' });
      const h = harness({ engine: { stats: async () => okOutput(never) } });
      expect(await doctor(h)).toBe(0);
      expect(lineFor(h, 'Index')).toBe('WARN  Index: nothing indexed yet; run "maxify index"');
    });

    it('WARN when the engine reports zero files in meta', async () => {
      register();
      const h = harness({ engine: { stats: async () => okOutput('anything', { meta: { estTokens: 1, complete: true, durationMs: 1, files: 0 } }) } });
      expect(await doctor(h)).toBe(0);
      expect(lineFor(h, 'Index')).toBe('WARN  Index: nothing indexed yet; run "maxify index"');
    });

    it('shows the first line of the report when it has no recognizable index section', async () => {
      register();
      const h = harness({ engine: { stats: async () => okOutput('\nindex ready, generation 3\nmore') } });
      expect(await doctor(h)).toBe(0);
      expect(lineFor(h, 'Index')).toBe('PASS  Index: index ready, generation 3');
    });

    it('WARN and skip the self-test when dist/cli.js has not been built', async () => {
      const missing = path.join(project.dir, 'nowhere', 'cli.js');
      const h = harness({ cliPath: missing });
      expect(await doctor(h)).toBe(0);
      expect(lineFor(h, 'MCP self-test')).toBe(`WARN  MCP self-test: skipped: ${missing} not found (run "npm run build")`);
      expect(h.deps.runMcpSelfTest).not.toHaveBeenCalled();
    });
  });

  it('prints checks and counts as JSON with --json', async () => {
    register();
    const h = harness();
    expect(await doctor(h, '--json')).toBe(0);
    const payload = JSON.parse(h.stdout()) as {
      text: string;
      meta: { checks: Array<{ status: string; name: string }>; passed: number; warnings: number; failed: number };
    };
    expect(payload.meta.failed).toBe(0);
    expect(payload.meta.checks.map((check) => check.name)).toEqual([
      'Node.js',
      'node:sqlite + FTS5',
      'TypeScript Compiler API',
      'Repository root',
      'State directory',
      'Config',
      'Index',
      '.mcp.json',
      'MCP self-test',
      'Tool surface',
    ]);
    expect(payload.meta.passed).toBe(payload.meta.checks.length);
  });

  it('rejects stray arguments', async () => {
    expect(await harness().run('doctor', 'now')).toBe(2);
  });
});

describe('doctor check helpers', () => {
  it('compares versions numerically', () => {
    expect(isVersionAtLeast('22.13.0', '22.13.0')).toBe(true);
    expect(isVersionAtLeast('22.22.1', '22.13.0')).toBe(true);
    expect(isVersionAtLeast('22.9.0', '22.13.0')).toBe(false);
    expect(isVersionAtLeast('23.0.0', '22.13.0')).toBe(true);
    expect(isVersionAtLeast('v24.1.0', '22.13.0')).toBe(true);
    expect(isVersionAtLeast('20.18.0', '22.13.0')).toBe(false);
    expect(isVersionAtLeast('22', '22.0.0')).toBe(true);
  });

  it('checkNode explains what is needed', () => {
    expect(checkNode('22.13.0').status).toBe('PASS');
    const old = checkNode('20.11.1');
    expect(old.status).toBe('FAIL');
    expect(old.detail).toContain('>= 22.13.0');
  });

  it('indexedFileCount reads the common meta keys', () => {
    expect(indexedFileCount({ files: 5 })).toBe(5);
    expect(indexedFileCount({ fileCount: 6 })).toBe(6);
    expect(indexedFileCount({ filesIndexed: 7 })).toBe(7);
    expect(indexedFileCount({ indexedFiles: 0 })).toBe(0);
    expect(indexedFileCount({ files: 'many' })).toBeUndefined();
    expect(indexedFileCount({})).toBeUndefined();
  });

  describe('readIndexHealth parses what the real engine prints', () => {
    const meta = { estTokens: 1, complete: true, durationMs: 1 };

    it('sums the per-status file counts', () => {
      const health = readIndexHealth({ text: HEALTHY_STATS, meta });
      expect(health.files).toBe(123);
      expect(health.neverIndexed).toBe(false);
      expect(health.summary).toBe('files ok 120, skipped 3; generation 3, last index 2026-10-26T10:00:00.000Z');
    });

    it('recognizes an index that was never built', () => {
      const health = readIndexHealth({ text: statsText({ generation: 0, lastIndex: 'never', files: 'none' }), meta });
      expect(health.files).toBe(0);
      expect(health.neverIndexed).toBe(true);
    });

    it('prefers a numeric meta.files over parsing text', () => {
      expect(readIndexHealth({ text: HEALTHY_STATS, meta: { ...meta, files: 7 } }).files).toBe(7);
    });

    it('copes with text it does not recognize', () => {
      const health = readIndexHealth({ text: 'something else entirely', meta });
      expect(health.files).toBeUndefined();
      expect(health.neverIndexed).toBe(false);
      expect(health.summary).toBe('something else entirely');
      expect(readIndexHealth({ text: '', meta }).summary).toBe('readable');
    });
  });

  it('formatCheck renders control characters visibly', () => {
    const line = formatCheck({ status: 'FAIL', name: 'x', detail: `bad\u0007name\u001b[0m` });
    expect(line).toBe('FAIL  x: bad\\x07name\\x1b[0m');
  });
});
