import { execFileSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MINI_REPO, writeRepo } from '../engine/fixture.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const cli = path.join(repoRoot, 'dist', 'cli.js');

let root: string;
let stateDir: string;
let client: Client;
let stderr = '';

type TextResult = { content: Array<{ type: string; text?: string }>; isError?: boolean; structuredContent?: unknown };

function textOf(result: unknown): string {
  const r = result as TextResult;
  return r.content.map((c) => (c.type === 'text' ? (c.text ?? '') : '')).join('\n');
}

beforeAll(async () => {
  execFileSync(process.execPath, [path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', path.join(repoRoot, 'tsconfig.build.json')], {
    cwd: repoRoot,
    stdio: 'pipe',
  });
  expect(existsSync(cli)).toBe(true);
  root = writeRepo(MINI_REPO, 'maxify-e2e-');
  stateDir = `${root}-state`;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cli, 'serve', '--root', root, '--state-dir', stateDir],
    stderr: 'pipe',
  });
  transport.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });
  client = new Client({ name: 'maxify-e2e', version: '0.0.0' });
  await client.connect(transport);
}, 120_000);

afterAll(async () => {
  await client?.close();
  rmSync(root, { recursive: true, force: true });
  rmSync(stateDir, { recursive: true, force: true });
});

describe('maxify serve over stdio with the official MCP client', () => {
  it('exposes exactly six tools and short server instructions', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      ['maxify_compress', 'maxify_context', 'maxify_impact', 'maxify_memory', 'maxify_source', 'maxify_stats'],
    );
    for (const tool of tools) expect(tool.outputSchema).toBeUndefined();
    const instructions = client.getInstructions() ?? '';
    expect(instructions).toContain('maxify_context');
    expect(instructions.length).toBeLessThan(4096);
  });

  it('answers a task with exact source as a single text block', async () => {
    const result = await client.callTool({ name: 'maxify_context', arguments: { task: 'Fix isExpired boundary at exp', budget: 2500 } });
    const text = textOf(result);
    expect((result as TextResult).isError).toBeFalsy();
    expect((result as TextResult).structuredContent).toBeUndefined();
    expect(text).toContain('return now > payload.exp;');
    expect(text).toContain('src/lib/token.ts');
  });

  it('serves exact source and refuses secrets with an isError result', async () => {
    const ok = await client.callTool({ name: 'maxify_source', arguments: { ref: 'src/auth.ts#requireAuth' } });
    expect(textOf(ok)).toContain("if (!header) throw new Error('missing token');");
    const denied = await client.callTool({ name: 'maxify_source', arguments: { ref: '.env' } });
    expect((denied as TextResult).isError).toBe(true);
    expect(textOf(denied)).toMatch(/secret/);
    expect(textOf(denied)).not.toContain('do-not-read');
  });

  it('compresses and recovers through blob refs', async () => {
    const log = [...Array.from({ length: 200 }, (_, i) => `INFO tick ${i}`), 'ERROR boom: invalid state 42', 'INFO done'].join('\n');
    const result = await client.callTool({ name: 'maxify_compress', arguments: { text: log } });
    const text = textOf(result);
    expect(text).toContain('ERROR boom: invalid state 42');
    const ref = /blob:([0-9a-f]{12})/.exec(text)?.[1];
    expect(ref).toBeTruthy();
    const back = await client.callTool({ name: 'maxify_compress', arguments: { ref: `blob:${ref}`, lines: '201-201' } });
    expect(textOf(back)).toContain('ERROR boom: invalid state 42');
  });

  it('keeps stdout clean (diagnostics only on stderr)', () => {
    expect(stderr).not.toMatch(/ExperimentalWarning/);
  });
});
