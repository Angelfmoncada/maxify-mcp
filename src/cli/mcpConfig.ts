/**
 * Project-scoped MCP registration (`.mcp.json`). The merge is a pure function
 * so every case is unit-tested without touching the filesystem.
 */
import { chmodSync, lstatSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { stableStringify } from '../core/hash.js';
import { MaxifyError } from '../core/errors.js';
import { log } from '../core/log.js';
import { decodeText } from './input.js';

export const MCP_CONFIG_FILE = '.mcp.json';
export const MCP_SERVER_KEY = 'maxify';

export interface McpServerEntry {
  type: 'stdio';
  command: string;
  args: string[];
}

export type JsonObject = Record<string, unknown>;

export type MergeResult =
  | { kind: 'created' | 'added' | 'replaced' | 'unchanged'; config: JsonObject }
  | { kind: 'conflict'; config: JsonObject; current: unknown }
  | { kind: 'invalid'; reason: string };

/**
 * Entry for `.mcp.json`. Without `root` the entry names no project: the server resolves it from
 * CLAUDE_PROJECT_DIR / the working directory. The script path is still this machine's absolute
 * path to the CLI.
 */
export function buildServerEntry(opts: { cliPath: string; root?: string; nodeCommand?: string }): McpServerEntry {
  return {
    type: 'stdio',
    command: opts.nodeCommand ?? 'node',
    args: [opts.cliPath, 'serve', ...(opts.root === undefined ? [] : ['--root', opts.root])],
  };
}

function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Merge the maxify entry into an existing `.mcp.json` document without
 * touching other servers or top-level keys. `existing` is the parsed file, or
 * undefined when the file does not exist. A different existing maxify entry is
 * a conflict unless `force` is set.
 */
export function mergeMcpConfig(existing: unknown, entry: McpServerEntry, force: boolean): MergeResult {
  if (existing === undefined || existing === null) {
    return { kind: 'created', config: { mcpServers: { [MCP_SERVER_KEY]: entry } } };
  }
  if (!isPlainObject(existing)) {
    return { kind: 'invalid', reason: `${MCP_CONFIG_FILE} must contain a JSON object at the top level.` };
  }
  const servers = existing.mcpServers;
  if (servers !== undefined && !isPlainObject(servers)) {
    return { kind: 'invalid', reason: `"mcpServers" in ${MCP_CONFIG_FILE} must be an object.` };
  }
  const current = servers?.[MCP_SERVER_KEY];
  const withEntry: JsonObject = { ...existing, mcpServers: { ...servers, [MCP_SERVER_KEY]: entry } };
  if (current === undefined) return { kind: 'added', config: withEntry };
  if (stableStringify(current) === stableStringify(entry)) return { kind: 'unchanged', config: existing };
  if (!force) return { kind: 'conflict', config: existing, current };
  return { kind: 'replaced', config: withEntry };
}

export type ReadResult =
  | { kind: 'missing' }
  | { kind: 'ok'; value: unknown }
  | { kind: 'invalid-json'; message: string }
  | { kind: 'unsafe'; message: string };

/** Config files are tiny; anything bigger is not one. */
export const MAX_CONFIG_BYTES = 1024 * 1024;

/**
 * Read a JSON config file from a project that may not be trusted. Symbolic links are refused
 * (a link such as `.mcp.json -> ~/.claude.json` would otherwise be read and then copied into
 * the project by a rewrite), as are special files and oversized files. A BOM (Notepad,
 * PowerShell) is stripped and UTF-16 is decoded.
 */
export function readJsonFile(file: string): ReadResult {
  let stats;
  try {
    stats = lstatSync(file);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' };
    return { kind: 'unsafe', message: `cannot inspect ${file}: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (stats.isSymbolicLink()) {
    return { kind: 'unsafe', message: `${file} is a symbolic link; Maxify will not read or replace it. Use a regular file.` };
  }
  if (!stats.isFile()) return { kind: 'unsafe', message: `${file} is not a regular file.` };
  if (stats.size > MAX_CONFIG_BYTES) {
    return { kind: 'unsafe', message: `${file} is larger than ${MAX_CONFIG_BYTES / 1024} KiB; it does not look like a config file.` };
  }
  try {
    return { kind: 'ok', value: JSON.parse(decodeText(readFileSync(file))) as unknown };
  } catch (error: unknown) {
    return { kind: 'invalid-json', message: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Write JSON (2-space indent, trailing newline) through a temp file so a crash never leaves half a
 * file. The temp file is created exclusively (`wx`), so a pre-planted symlink is never followed,
 * and it takes over the permissions of the file it replaces (a 0600 file stays 0600).
 */
export function writeJsonFile(file: string, value: unknown): void {
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  try {
    removeIfPresent(temp);
    writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    copyMode(file, temp);
    renameSync(temp, file);
  } catch (error: unknown) {
    removeIfPresent(temp);
    throw new MaxifyError(
      'INTERNAL',
      `Cannot write ${file}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function copyMode(from: string, to: string): void {
  try {
    chmodSync(to, statSync(from).mode & 0o777);
  } catch (error: unknown) {
    // A new file has nothing to copy from; the default mode is right for it.
    log.debug(`keep default mode for ${to}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function removeIfPresent(file: string): void {
  try {
    unlinkSync(file);
  } catch (error: unknown) {
    // A missing file is the normal case; anything else will surface when the file is written.
    log.debug(`remove ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Absolute `.js` path in the entry's args, if any (the CLI entry the server runs). */
export function entryScriptPath(entry: unknown): string | undefined {
  if (!isPlainObject(entry) || !Array.isArray(entry.args)) return undefined;
  const script = entry.args.find((arg): arg is string => typeof arg === 'string' && /\.(?:c|m)?js$/i.test(arg));
  return script;
}

export function mcpServerEntryOf(config: unknown): unknown {
  if (!isPlainObject(config) || !isPlainObject(config.mcpServers)) return undefined;
  return config.mcpServers[MCP_SERVER_KEY];
}
