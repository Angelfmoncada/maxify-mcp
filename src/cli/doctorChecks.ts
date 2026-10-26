/** Individual `maxify doctor` checks. Each returns a CheckResult and never throws. */
import { randomBytes } from 'node:crypto';
import { mkdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../config/config.js';
import type { MaxifyEngine, ToolOutput } from '../engine/types.js';
import { MCP_CONFIG_FILE, entryScriptPath, mcpServerEntryOf, readJsonFile } from './mcpConfig.js';
import type { RepoLocation } from './root.js';
import { visible } from './text.js';

export type CheckStatus = 'PASS' | 'WARN' | 'FAIL';

export interface CheckResult {
  status: CheckStatus;
  name: string;
  detail: string;
}

export const MIN_NODE_VERSION = '22.13.0';

const pass = (name: string, detail: string): CheckResult => ({ status: 'PASS', name, detail });
const warn = (name: string, detail: string): CheckResult => ({ status: 'WARN', name, detail });
const fail = (name: string, detail: string): CheckResult => ({ status: 'FAIL', name, detail });

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseVersion(version: string): [number, number, number] {
  const [major = 0, minor = 0, patch = 0] = version.replace(/^v/, '').split('.').map((part) => Number.parseInt(part, 10) || 0);
  return [major, minor, patch];
}

export function isVersionAtLeast(actual: string, minimum: string): boolean {
  const a = parseVersion(actual);
  const b = parseVersion(minimum);
  for (let i = 0; i < 3; i++) {
    const left = a[i] ?? 0;
    const right = b[i] ?? 0;
    if (left !== right) return left > right;
  }
  return true;
}

export function checkNode(version: string = process.versions.node): CheckResult {
  const name = 'Node.js';
  return isVersionAtLeast(version, MIN_NODE_VERSION)
    ? pass(name, `${version} (>= ${MIN_NODE_VERSION} required)`)
    : fail(name, `${version} is too old; Maxify needs Node.js >= ${MIN_NODE_VERSION} (node:sqlite)`);
}

export async function checkSqlite(): Promise<CheckResult> {
  const name = 'node:sqlite + FTS5';
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(':memory:');
    try {
      db.exec('CREATE VIRTUAL TABLE doctor_fts USING fts5(body)');
      db.prepare('INSERT INTO doctor_fts (body) VALUES (?)').run('maxify doctor check');
      const row = db.prepare('SELECT count(*) AS n FROM doctor_fts WHERE doctor_fts MATCH ?').get('doctor');
      if (row?.n !== 1) return fail(name, 'FTS5 query returned an unexpected result');
    } finally {
      db.close();
    }
    return pass(name, 'available, FTS5 works');
  } catch (error: unknown) {
    return fail(name, errorMessage(error));
  }
}

export async function checkTypeScript(): Promise<CheckResult> {
  const name = 'TypeScript Compiler API';
  try {
    const module = await import('typescript');
    const ts = module.default ?? module;
    if (typeof ts.createSourceFile !== 'function') return fail(name, 'the typescript package has no compiler API');
    return pass(name, `typescript ${ts.version}`);
  } catch (error: unknown) {
    return fail(name, `cannot load the typescript package: ${errorMessage(error)}`);
  }
}

export function checkRoot(location: RepoLocation): CheckResult {
  return pass('Repository root', `${location.root} (${location.rootSource})`);
}

export function checkStateDir(stateDir: string): CheckResult {
  const name = 'State directory';
  const probe = path.join(stateDir, `.doctor-${process.pid}-${randomBytes(4).toString('hex')}.tmp`);
  try {
    mkdirSync(stateDir, { recursive: true });
    // Exclusive create: a symlink planted at this name is never followed.
    writeFileSync(probe, 'ok', { flag: 'wx' });
    unlinkSync(probe);
    return pass(name, `${stateDir} is writable`);
  } catch (error: unknown) {
    return fail(name, `${stateDir} is not writable: ${errorMessage(error)}`);
  }
}

export function checkConfig(location: RepoLocation): CheckResult {
  const name = 'Config';
  try {
    const loaded = loadConfig(location.root, location.configPath);
    return pass(name, loaded.source === null ? 'no maxify.config.json; defaults in use' : `valid (${loaded.source})`);
  } catch (error: unknown) {
    return fail(name, errorMessage(error));
  }
}

const INDEXED_COUNT_KEYS = ['files', 'fileCount', 'filesIndexed', 'indexedFiles'] as const;

/** The file count if the engine reports one in `meta` under a common key. */
export function indexedFileCount(meta: Record<string, unknown>): number | undefined {
  for (const key of INDEXED_COUNT_KEYS) {
    const value = meta[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
}

export interface IndexHealth {
  /** Indexed files: from `meta`, else summed from the report's "files:" line. */
  files: number | undefined;
  neverIndexed: boolean;
  /** One line describing the index, taken from the report. */
  summary: string;
}

function sumNumbers(text: string): number {
  return (text.match(/\d+/g) ?? []).reduce((total, digits) => total + Number(digits), 0);
}

/**
 * Read index health from a `maxify_stats` result: a numeric `meta.files` when present, otherwise the
 * "generation N ... last index X" and "files: ..." lines of the index section.
 */
export function readIndexHealth(output: Pick<ToolOutput, 'text' | 'meta'>): IndexHealth {
  const lines = output.text.split('\n').map((line) => line.trim());
  const generation = lines.map((line) => /^generation (\d+)\b.*?\blast index (\S+)/.exec(line)).find((match) => match !== null);
  const filesLine = lines.find((line) => line.startsWith('files:'));
  const filesText = filesLine?.slice('files:'.length).trim();
  const fromReport = filesText === undefined ? undefined : filesText === 'none' ? 0 : sumNumbers(filesText);
  const files = indexedFileCount(output.meta) ?? fromReport;
  const neverIndexed = generation?.[2] === 'never';
  const parts = [
    filesText === undefined ? undefined : `files ${filesText}`,
    generation === undefined || generation === null ? undefined : `generation ${generation[1]}, last index ${generation[2]}`,
  ].filter((part): part is string => part !== undefined);
  const firstLine = lines.find((line) => line.length > 0) ?? 'readable';
  return { files, neverIndexed, summary: parts.length > 0 ? parts.join('; ') : firstLine };
}

export async function checkIndex(engine: MaxifyEngine): Promise<CheckResult> {
  const name = 'Index';
  try {
    const stats = await engine.stats({ scope: 'index' });
    if (stats.isError === true) return fail(name, stats.text.split('\n')[0] ?? 'stats failed');
    const health = readIndexHealth(stats);
    if (health.neverIndexed || health.files === 0) return warn(name, 'nothing indexed yet; run "maxify index"');
    return pass(name, health.summary);
  } catch (error: unknown) {
    return fail(name, errorMessage(error));
  }
}

export function checkIndexUnavailable(error: unknown): CheckResult {
  return fail('Index', `cannot open the engine: ${errorMessage(error)}`);
}

const NODE_COMMAND = /^node(?:\.exe)?$/i;

function isNetworkPath(value: string): boolean {
  return value.startsWith('\\\\') || value.startsWith('//');
}

function isRegularFile(file: string): boolean {
  try {
    return statSync(file).isFile();
  } catch {
    // Missing or unreadable: the caller reports it as missing.
    return false;
  }
}

/** Judge a `.mcp.json` maxify entry. The file belongs to the repository, so nothing in it is executed here. */
function inspectEntry(entry: unknown, root: string): CheckResult {
  const name = MCP_CONFIG_FILE;
  const command = typeof entry === 'object' && entry !== null ? (entry as { command?: unknown }).command : undefined;
  if (typeof command !== 'string' || !NODE_COMMAND.test(path.basename(command.replace(/\\/g, '/')))) {
    return warn(name, `maxify entry does not run node (command ${JSON.stringify(command)}); cannot verify it`);
  }
  const script = entryScriptPath(entry);
  if (script === undefined) return warn(name, 'maxify entry found, but its args have no .js path to verify');
  if (isNetworkPath(script)) return warn(name, `maxify entry runs a script on a network path (${script}); not checked`);
  const resolved = path.resolve(root, script);
  if (!isRegularFile(resolved)) {
    return fail(name, `maxify entry points to a missing file: ${resolved}; run "maxify init --force"`);
  }
  const args = (entry as { args?: unknown }).args;
  if (!Array.isArray(args) || args[args.indexOf(script) + 1] !== 'serve') {
    return warn(name, `maxify entry runs ${resolved} but not its "serve" command`);
  }
  return pass(name, `maxify entry points to ${resolved}`);
}

export function checkMcpJson(root: string): CheckResult {
  const name = MCP_CONFIG_FILE;
  const file = path.join(root, MCP_CONFIG_FILE);
  const read = readJsonFile(file);
  if (read.kind === 'missing') return warn(name, 'not found; run "maxify init" to register the server');
  if (read.kind === 'unsafe') return fail(name, read.message);
  if (read.kind === 'invalid-json') return fail(name, `${file} is not valid JSON: ${read.message}`);
  const entry = mcpServerEntryOf(read.value);
  if (entry === undefined) return warn(name, 'no "maxify" server; run "maxify init"');
  return inspectEntry(entry, root);
}

/** One output line. Details may contain text from the repository, so control characters are made visible. */
export function formatCheck(check: CheckResult): string {
  return visible(`${check.status}  ${check.name}: ${check.detail}`);
}

export function summarizeChecks(checks: readonly CheckResult[]): { passed: number; warnings: number; failed: number } {
  return {
    passed: checks.filter((check) => check.status === 'PASS').length,
    warnings: checks.filter((check) => check.status === 'WARN').length,
    failed: checks.filter((check) => check.status === 'FAIL').length,
  };
}
