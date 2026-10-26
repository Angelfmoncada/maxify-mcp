import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { vi } from 'vitest';
import type { CliDeps } from '../../src/cli/deps.js';
import { main } from '../../src/cli/main.js';
import type { EngineOptions, MaxifyEngine } from '../../src/engine/types.js';
import { createFakeEngine, type FakeEngine } from '../mcp/helpers.js';

export interface Harness {
  deps: CliDeps;
  fake: FakeEngine;
  /** Everything written to stdout / stderr so far. */
  stdout(): string;
  stderr(): string;
  /** Options each openEngine call received. */
  opened: EngineOptions[];
  /** Run the CLI and return the exit code. */
  run(...argv: string[]): Promise<number>;
}

export interface HarnessOptions {
  cwd?: string;
  env?: Record<string, string>;
  stdin?: string;
  stdinIsTTY?: boolean;
  engine?: Partial<MaxifyEngine>;
  cliPath?: string;
  deps?: Partial<CliDeps>;
}

export function createHarness(options: HarnessOptions = {}): Harness {
  const out: string[] = [];
  const err: string[] = [];
  const opened: EngineOptions[] = [];
  const fake = createFakeEngine(options.engine);
  const deps: CliDeps = {
    io: {
      out: (text) => void out.push(text),
      err: (text) => void err.push(text),
      stdinIsTTY: options.stdinIsTTY ?? false,
      readStdin: async () => options.stdin ?? '',
    },
    cwd: options.cwd ?? process.cwd(),
    env: { ...options.env },
    version: '1.2.3',
    cliPath: options.cliPath ?? path.join(path.parse(process.cwd()).root, 'fake', 'dist', 'cli.js'),
    openEngine: vi.fn(async (opts: EngineOptions) => {
      opened.push(opts);
      return fake.engine;
    }),
    serve: vi.fn(async () => ({
      server: new McpServer({ name: 'test', version: '0' }),
      shutdown: () => undefined,
      closed: Promise.resolve(),
    })),
    runOfflineBench: vi.fn(async () => ({ text: '# offline bench report', exitCode: 0 })),
    runMcpSelfTest: vi.fn(async () => ({ ok: true, message: '6 tools listed', toolNames: [], durationMs: 3 })),
    ...options.deps,
  };
  return {
    deps,
    fake,
    stdout: () => out.join(''),
    stderr: () => err.join(''),
    opened,
    run: (...argv) => main(argv, deps),
  };
}

export interface TempProject {
  dir: string;
  cleanup(): void;
}

/** A throwaway repository root (has a .git directory so root detection stops here). */
export function createTempProject(files: Record<string, string> = {}): TempProject {
  const dir = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'maxify-cli-')));
  mkdirSync(path.join(dir, '.git'));
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(dir, name);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
