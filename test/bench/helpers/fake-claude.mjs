#!/usr/bin/env node
// Scripted stand-in for `claude -p ... --output-format stream-json`. TEST ONLY: it never contacts any API.
// Behavior is chosen with environment variables:
//   FAKE_CLAUDE_LOG       file that receives one JSON line per invocation (argv, cwd, CLAUDE.md, settings, .mcp.json)
//   FAKE_CLAUDE_MODE      solve (default) | idle | crash | maxturns | hang
//   FAKE_CLAUDE_SOLUTION  patch applied with git in the workspace when mode is "solve"
//   FAKE_CLAUDE_ANSWER    file whose content becomes the final answer text
//   FAKE_CLAUDE_COST      total_cost_usd reported in the result event (default 0.2)
//   FAKE_CLAUDE_DROP_MCP  when set, the init event lists no MCP servers (as if every server failed to start)
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const argv = process.argv.slice(2);
if (argv[0] === '--version') {
  process.stdout.write('0.0.0-fake (Claude Code stand-in)\n');
  process.exit(0);
}

const readIfExists = (file) => (file !== undefined && existsSync(file) ? readFileSync(file, 'utf8') : null);
const flagValue = (name) => {
  const index = argv.indexOf(name);
  return index < 0 ? undefined : argv[index + 1];
};

const mode = process.env.FAKE_CLAUDE_MODE ?? 'solve';
const mcpConfig = readIfExists(flagValue('--mcp-config'));
const settings = readIfExists(path.join(process.cwd(), '.claude', 'settings.json'));
const entry = {
  argv,
  cwd: process.cwd(),
  claudeMd: readIfExists(path.join(process.cwd(), 'CLAUDE.md')),
  settings: settings === null ? null : JSON.parse(settings),
  mcpConfig: mcpConfig === null ? null : JSON.parse(mcpConfig),
  hasHiddenTest: existsSync(path.join(process.cwd(), 'test', 'hidden.test.ts')),
  mode,
};
if (process.env.FAKE_CLAUDE_LOG) appendFileSync(process.env.FAKE_CLAUDE_LOG, `${JSON.stringify(entry)}\n`);

const servers = process.env.FAKE_CLAUDE_DROP_MCP ? [] : Object.keys(entry.mcpConfig?.mcpServers ?? {});
const plugins = Object.keys(entry.settings?.enabledPlugins ?? {}).map((id) => id.split('@')[0]);
const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);

emit({
  type: 'system',
  subtype: 'init',
  session_id: 'fake-session',
  cwd: process.cwd(),
  model: 'claude-fake',
  permissionMode: 'acceptEdits',
  apiKeySource: 'none',
  tools: ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash', ...servers.map((server) => `mcp__${server}__${server}_context`)],
  mcp_servers: servers.map((name) => ({ name, status: 'connected' })),
  plugins: plugins.map((name) => ({ name, path: `/fake/${name}` })),
  slash_commands: ['compact'],
});

if (mode === 'crash') process.exit(3);
if (mode === 'hang') {
  setInterval(() => undefined, 1000);
} else {
  if (mode === 'solve' && process.env.FAKE_CLAUDE_SOLUTION) {
    const applied = spawnSync('git', ['apply', '--whitespace=nowarn', process.env.FAKE_CLAUDE_SOLUTION], { cwd: process.cwd(), encoding: 'utf8' });
    if (applied.status !== 0) process.stderr.write(`fake claude: git apply failed: ${applied.stderr}\n`);
  }
  const toolNames = ['Read', 'Edit', ...servers.map((server) => `mcp__${server}__${server}_context`)];
  toolNames.forEach((name, index) => {
    const usage = { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: index === 0 ? 3000 : 0, cache_read_input_tokens: index === 0 ? 0 : 3000 };
    emit({ type: 'assistant', message: { id: `msg_${index}`, content: [{ type: 'tool_use', id: `tool_${index}`, name, input: {} }], usage }, parent_tool_use_id: null });
    emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: `tool_${index}`, content: 'ok', is_error: false }] } });
  });
  emit({
    type: 'result',
    subtype: mode === 'maxturns' ? 'error_max_turns' : 'success',
    is_error: mode === 'maxturns',
    duration_ms: 1500,
    duration_api_ms: 1200,
    num_turns: toolNames.length + 1,
    total_cost_usd: Number(process.env.FAKE_CLAUDE_COST ?? 0.2),
    session_id: 'fake-session',
    result: readIfExists(process.env.FAKE_CLAUDE_ANSWER) ?? 'Done.',
    usage: { input_tokens: 100, output_tokens: 200, cache_creation_input_tokens: 3000, cache_read_input_tokens: 3000 * Math.max(toolNames.length - 1, 0) },
    permission_denials: [],
  });
}
