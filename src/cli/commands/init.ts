/**
 * `maxify init`: register the MCP server for this project, optionally write a
 * config file, and build the first index. Global Claude Code configuration is
 * never touched.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { CONFIG_FILE, DEFAULT_CONFIG, loadConfig } from '../../config/config.js';
import { MaxifyError } from '../../core/errors.js';
import { booleanOption, rejectPositionals } from '../args.js';
import { info, locate, printResult, withEngine, type CommandCall, type CommandSpec } from '../command.js';
import { formatIndexSummary } from './indexCmd.js';
import {
  MCP_CONFIG_FILE,
  buildServerEntry,
  mergeMcpConfig,
  readJsonFile,
  writeJsonFile,
  type MergeResult,
} from '../mcpConfig.js';
import type { RepoLocation } from '../root.js';

const MERGE_MESSAGES: Record<'created' | 'added' | 'replaced' | 'unchanged', string> = {
  created: `created ${MCP_CONFIG_FILE} with the maxify server`,
  added: `added the maxify server to ${MCP_CONFIG_FILE} (other servers kept)`,
  replaced: `replaced the maxify server in ${MCP_CONFIG_FILE} (--force)`,
  unchanged: `${MCP_CONFIG_FILE} already registers maxify; left unchanged`,
};

function describeMergeFailure(result: Extract<MergeResult, { kind: 'conflict' | 'invalid' }>): string {
  if (result.kind === 'invalid') return `${result.reason} Fix or remove the file, then run "maxify init" again.`;
  return (
    `${MCP_CONFIG_FILE} already has a different "maxify" server:\n` +
    `  ${JSON.stringify(result.current)}\n` +
    'Not replacing it. Re-run with --force to overwrite that entry (other servers are kept).'
  );
}

function registerMcpServer(call: CommandCall, location: RepoLocation): string {
  const file = path.join(location.root, MCP_CONFIG_FILE);
  const existing = readJsonFile(file);
  if (existing.kind === 'unsafe') throw new MaxifyError('INVALID_INPUT', existing.message);
  if (existing.kind === 'invalid-json') {
    throw new MaxifyError(
      'INVALID_INPUT',
      `${file} is not valid JSON (${existing.message}). Fix or remove the file, then run "maxify init" again.`,
    );
  }
  const entry = buildServerEntry({
    cliPath: call.deps.cliPath,
    ...(booleanOption(call.values, 'pin-root') ? { root: location.root } : {}),
  });
  const merged = mergeMcpConfig(existing.kind === 'ok' ? existing.value : undefined, entry, booleanOption(call.values, 'force'));
  if (merged.kind === 'conflict' || merged.kind === 'invalid') {
    throw new MaxifyError('INVALID_INPUT', describeMergeFailure(merged));
  }
  if (merged.kind !== 'unchanged') writeJsonFile(file, merged.config);
  return `${MERGE_MESSAGES[merged.kind]} (${file})`;
}

function writeConfigFile(call: CommandCall, location: RepoLocation): string {
  const file = path.join(location.root, CONFIG_FILE);
  if (existsSync(file) && !booleanOption(call.values, 'force')) {
    return `${CONFIG_FILE} already exists; left unchanged (${file})`;
  }
  writeJsonFile(file, DEFAULT_CONFIG);
  // Fail loudly if the file we just wrote would not load.
  loadConfig(location.root, file);
  return `wrote ${CONFIG_FILE} with the default settings (${file})`;
}

function nextSteps(registered: boolean): string[] {
  if (!registered) {
    return ['', 'Next: run "maxify doctor" to check the setup, or register "maxify serve" in your MCP client yourself.'];
  }
  return [
    '',
    'Next steps:',
    '  1. Start Claude Code in this project. It will ask you to approve the project MCP server "maxify".',
    '  2. Check that it is connected: claude mcp list',
    '  3. If Claude Code was already running, restart the session.',
    '  4. Run "maxify doctor" any time to verify the setup.',
  ];
}

export const initCommand: CommandSpec = {
  name: 'init',
  summary: 'Register the MCP server in .mcp.json and build the first index.',
  usage: 'init [--no-mcp] [--write-config] [--force] [--pin-root]',
  details: [
    'Creates or merges <root>/.mcp.json (other servers are preserved) and indexes the repository.',
    'The entry has no --root, so it follows $CLAUDE_PROJECT_DIR; use --pin-root to hard-code this root.',
  ],
  options: {
    'no-mcp': { type: 'boolean' },
    'write-config': { type: 'boolean' },
    force: { type: 'boolean' },
    'pin-root': { type: 'boolean' },
  },
  optionDocs: [
    { flag: '--no-mcp', description: `Do not create or change ${MCP_CONFIG_FILE}.` },
    { flag: '--write-config', description: `Write ${CONFIG_FILE} with the default settings.` },
    { flag: '--force', description: 'Replace a different existing maxify entry / existing config file.' },
    { flag: '--pin-root', description: 'Add --root <this root> to the server entry.' },
  ],
  async run(call) {
    rejectPositionals(call.positionals);
    const registerMcp = !booleanOption(call.values, 'no-mcp');
    const location = locate(call);
    const steps: string[] = [];
    if (registerMcp) steps.push(registerMcpServer(call, location));
    if (booleanOption(call.values, 'write-config')) steps.push(writeConfigFile(call, location));
    info(call, `indexing ${location.root}`);
    try {
      const summary = await withEngine(call, false, (engine) => engine.index(), location);
      steps.push(formatIndexSummary(location.root, summary), ...nextSteps(registerMcp));
      return printResult(call, {
        text: steps.join('\n'),
        meta: { root: location.root, mcp: registerMcp, index: { ...summary } },
      });
    } catch (error: unknown) {
      // The files above are already written; say so next to the failure.
      const reason = error instanceof Error ? error.message : String(error);
      steps.push(`index failed: ${reason}`, 'Fix the problem and run "maxify index".');
      return printResult(call, {
        text: steps.join('\n'),
        meta: { root: location.root, mcp: registerMcp },
        isError: true,
      });
    }
  },
};
