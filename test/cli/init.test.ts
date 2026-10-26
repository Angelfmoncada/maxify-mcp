import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, loadConfig } from '../../src/config/config.js';
import { EMPTY_SUMMARY } from '../mcp/helpers.js';
import { createHarness, createTempProject, type Harness, type TempProject } from './helpers.js';

const CLI_PATH = path.join(path.parse(process.cwd()).root, 'opt', 'maxify', 'dist', 'cli.js');

describe('maxify init', () => {
  let project: TempProject;
  beforeEach(() => {
    project = createTempProject();
  });
  afterEach(() => {
    project.cleanup();
  });

  const harness = (options: Parameters<typeof createHarness>[0] = {}): Harness =>
    createHarness({ cwd: project.dir, cliPath: CLI_PATH, ...options });
  const mcpFile = (): string => path.join(project.dir, '.mcp.json');
  const readMcp = (): unknown => JSON.parse(readFileSync(mcpFile(), 'utf8'));

  it('creates a portable .mcp.json entry (no --root) and indexes', async () => {
    const h = harness();
    expect(await h.run('init')).toBe(0);
    expect(readMcp()).toEqual({
      mcpServers: { maxify: { type: 'stdio', command: 'node', args: [CLI_PATH, 'serve'] } },
    });
    expect(h.stdout()).toContain('created .mcp.json with the maxify server');
    expect(h.stdout()).toContain('Indexed');
    expect(h.opened[0]).toMatchObject({ root: project.dir, autoIndex: false });
  });

  it('prints the next steps for Claude Code', async () => {
    const h = harness();
    await h.run('init');
    expect(h.stdout()).toContain('ask you to approve the project MCP server "maxify"');
    expect(h.stdout()).toContain('claude mcp list');
    expect(h.stdout()).toContain('restart the session');
    expect(h.stdout()).toContain('maxify doctor');
  });

  it('pins the root with --pin-root', async () => {
    const h = harness();
    await h.run('init', '--pin-root');
    expect(readMcp()).toEqual({
      mcpServers: { maxify: { type: 'stdio', command: 'node', args: [CLI_PATH, 'serve', '--root', project.dir] } },
    });
  });

  it('preserves other servers and top-level keys when merging', async () => {
    writeFileSync(
      mcpFile(),
      JSON.stringify({ mcpServers: { docs: { type: 'http', url: 'https://x.test/mcp' } }, extra: true }),
    );
    const h = harness();
    expect(await h.run('init')).toBe(0);
    const merged = readMcp() as { mcpServers: Record<string, unknown>; extra: boolean };
    expect(Object.keys(merged.mcpServers)).toEqual(['docs', 'maxify']);
    expect(merged.mcpServers.docs).toEqual({ type: 'http', url: 'https://x.test/mcp' });
    expect(merged.extra).toBe(true);
    expect(h.stdout()).toContain('other servers kept');
  });

  it('is idempotent', async () => {
    await harness().run('init');
    const before = readFileSync(mcpFile(), 'utf8');
    const second = harness();
    expect(await second.run('init')).toBe(0);
    expect(readFileSync(mcpFile(), 'utf8')).toBe(before);
    expect(second.stdout()).toContain('already registers maxify; left unchanged');
  });

  it('refuses to replace a different maxify entry without --force, and changes nothing', async () => {
    const original = JSON.stringify({ mcpServers: { maxify: { type: 'stdio', command: 'npx', args: ['maxify-mcp'] } } });
    writeFileSync(mcpFile(), original);
    const h = harness();
    expect(await h.run('init')).toBe(1);
    expect(h.stderr()).toContain('already has a different "maxify" server');
    expect(h.stderr()).toContain('--force');
    expect(readFileSync(mcpFile(), 'utf8')).toBe(original);
    expect(h.opened).toHaveLength(0);
  });

  it('replaces that entry with --force and keeps the other servers', async () => {
    writeFileSync(
      mcpFile(),
      JSON.stringify({ mcpServers: { maxify: { command: 'old' }, docs: { type: 'http', url: 'u' } } }),
    );
    const h = harness();
    expect(await h.run('init', '--force')).toBe(0);
    expect(readMcp()).toEqual({
      mcpServers: {
        maxify: { type: 'stdio', command: 'node', args: [CLI_PATH, 'serve'] },
        docs: { type: 'http', url: 'u' },
      },
    });
    expect(h.stdout()).toContain('replaced the maxify server');
  });

  it('refuses to touch a .mcp.json that is not valid JSON', async () => {
    writeFileSync(mcpFile(), '{ nope');
    const h = harness();
    expect(await h.run('init')).toBe(1);
    expect(h.stderr()).toContain('is not valid JSON');
    expect(readFileSync(mcpFile(), 'utf8')).toBe('{ nope');
  });

  it('refuses a .mcp.json whose top level is not an object', async () => {
    writeFileSync(mcpFile(), '[]');
    const h = harness();
    expect(await h.run('init')).toBe(1);
    expect(h.stderr()).toContain('must contain a JSON object');
  });

  it('--no-mcp leaves .mcp.json alone but still indexes', async () => {
    const h = harness();
    expect(await h.run('init', '--no-mcp')).toBe(0);
    expect(existsSync(mcpFile())).toBe(false);
    expect(h.stdout()).toContain('Indexed');
    expect(h.stdout()).not.toContain('claude mcp list');
    expect(h.stdout()).toContain('maxify doctor');
  });

  describe('--write-config', () => {
    const configFile = (): string => path.join(project.dir, 'maxify.config.json');

    it('writes the default settings and the file loads back', async () => {
      const h = harness();
      expect(await h.run('init', '--write-config')).toBe(0);
      expect(JSON.parse(readFileSync(configFile(), 'utf8'))).toEqual(DEFAULT_CONFIG);
      expect(loadConfig(project.dir).config).toEqual(DEFAULT_CONFIG);
      expect(h.stdout()).toContain('wrote maxify.config.json');
    });

    it('does not overwrite an existing config unless forced', async () => {
      writeFileSync(configFile(), '{ "respectGitignore": false }');
      const kept = harness();
      expect(await kept.run('init', '--write-config')).toBe(0);
      expect(readFileSync(configFile(), 'utf8')).toBe('{ "respectGitignore": false }');
      expect(kept.stdout()).toContain('already exists; left unchanged');

      const forced = harness();
      expect(await forced.run('init', '--write-config', '--force')).toBe(0);
      expect(JSON.parse(readFileSync(configFile(), 'utf8'))).toEqual(DEFAULT_CONFIG);
    });

    it('does not write a config unless asked', async () => {
      await harness().run('init');
      expect(existsSync(configFile())).toBe(false);
    });
  });

  it('keeps the files it wrote and fails clearly when indexing fails', async () => {
    const h = harness({
      engine: {
        index: async () => {
          throw new Error('database is locked');
        },
      },
    });
    expect(await h.run('init')).toBe(1);
    expect(existsSync(mcpFile())).toBe(true);
    expect(h.stderr()).toContain('created .mcp.json');
    expect(h.stderr()).toContain('index failed: database is locked');
    expect(h.stderr()).toContain('maxify index');
    expect(h.stdout()).toBe('');
  });

  it('prints one JSON document with --json', async () => {
    const h = harness({ engine: { index: async () => ({ ...EMPTY_SUMMARY, generation: 4 }) } });
    expect(await h.run('init', '--json', '--quiet')).toBe(0);
    const payload = JSON.parse(h.stdout()) as { text: string; meta: { root: string; mcp: boolean; index: { generation: number } } };
    expect(payload.meta).toMatchObject({ root: project.dir, mcp: true, index: { generation: 4 } });
    expect(payload.text).toContain('created .mcp.json');
  });

  it('does not touch the home directory or global Claude settings', async () => {
    const h = harness();
    await h.run('init');
    const touched = [h.stdout(), h.stderr()].join('');
    expect(touched).not.toContain('.claude.json');
  });

  it('rejects stray arguments', async () => {
    expect(await harness().run('init', 'now')).toBe(2);
  });
});
