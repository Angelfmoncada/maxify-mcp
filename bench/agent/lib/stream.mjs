// Parser for `claude -p --output-format stream-json --verbose` output. Pure functions, defensive about shape.
//
// Event shapes relied on (Claude Code 2.1.x):
//   {type:'system', subtype:'init', session_id, model, tools:[...], mcp_servers:[{name,status}], plugins?:[...], slash_commands:[...], apiKeySource, ...}
//   {type:'assistant', message:{id, usage:{...}, content:[{type:'text'|'tool_use'|'thinking', ...}]}, parent_tool_use_id}
//   {type:'user', message:{content:[{type:'tool_result', tool_use_id, content, is_error}]}}
//   {type:'result', subtype, is_error, duration_ms, duration_api_ms, num_turns, total_cost_usd, usage:{...}, result, permission_denials:[...]}
// Anything missing degrades to zeros/nulls and the run is flagged by the caller; nothing here throws on odd input.

/** Splits stdout into JSON events. Lines that are not JSON are counted, not fatal. */
export function parseJsonLines(text) {
  const events = [];
  let invalidLines = 0;
  for (const line of String(text).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    try {
      const value = JSON.parse(trimmed);
      if (value !== null && typeof value === 'object') events.push(value);
      else invalidLines += 1;
    } catch {
      invalidLines += 1;
    }
  }
  return { events, invalidLines };
}

function numberOr(value, fallback = 0) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function emptyUsage() {
  return { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };
}

/** Maps the provider's usage object to our field names. */
export function normalizeUsage(usage) {
  const source = usage !== null && typeof usage === 'object' ? usage : {};
  return {
    inputTokens: numberOr(source.input_tokens),
    outputTokens: numberOr(source.output_tokens),
    cacheCreationTokens: numberOr(source.cache_creation_input_tokens),
    cacheReadTokens: numberOr(source.cache_read_input_tokens),
  };
}

export function totalTokens(usage) {
  return usage.inputTokens + usage.outputTokens + usage.cacheCreationTokens + usage.cacheReadTokens;
}

function addUsage(a, b) {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
  };
}

function maxUsage(a, b) {
  return {
    inputTokens: Math.max(a.inputTokens, b.inputTokens),
    outputTokens: Math.max(a.outputTokens, b.outputTokens),
    cacheCreationTokens: Math.max(a.cacheCreationTokens, b.cacheCreationTokens),
    cacheReadTokens: Math.max(a.cacheReadTokens, b.cacheReadTokens),
  };
}

function stringList(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string') : [];
}

function nameOf(entry) {
  if (typeof entry === 'string') return entry;
  if (entry !== null && typeof entry === 'object' && typeof entry.name === 'string') return entry.name;
  return '';
}

export function normalizeInit(event) {
  const servers = Array.isArray(event.mcp_servers) ? event.mcp_servers : [];
  return {
    sessionId: typeof event.session_id === 'string' ? event.session_id : null,
    model: typeof event.model === 'string' ? event.model : null,
    cwd: typeof event.cwd === 'string' ? event.cwd : null,
    permissionMode: typeof event.permissionMode === 'string' ? event.permissionMode : null,
    apiKeySource: typeof event.apiKeySource === 'string' ? event.apiKeySource : null,
    tools: stringList(event.tools),
    mcpServers: servers.map((server) => ({
      name: nameOf(server),
      status: server !== null && typeof server === 'object' && typeof server.status === 'string' ? server.status : 'unknown',
    })),
    plugins: (Array.isArray(event.plugins) ? event.plugins : []).map(nameOf).filter((name) => name !== ''),
    slashCommands: stringList(event.slash_commands),
    skills: stringList(event.skills),
    agents: stringList(event.agents),
  };
}

export function normalizeResult(event) {
  const denials = Array.isArray(event.permission_denials) ? event.permission_denials : [];
  return {
    subtype: typeof event.subtype === 'string' ? event.subtype : 'unknown',
    isError: event.is_error === true,
    durationMs: numberOr(event.duration_ms),
    durationApiMs: numberOr(event.duration_api_ms),
    numTurns: numberOr(event.num_turns),
    totalCostUsd: numberOr(event.total_cost_usd),
    usage: normalizeUsage(event.usage),
    modelUsage: event.modelUsage !== null && typeof event.modelUsage === 'object' ? event.modelUsage : {},
    permissionDenials: denials.map((denial) => ({
      toolName: denial !== null && typeof denial === 'object' && typeof denial.tool_name === 'string' ? denial.tool_name : 'unknown',
    })),
    text: typeof event.result === 'string' ? event.result : '',
    sessionId: typeof event.session_id === 'string' ? event.session_id : null,
  };
}

function toolResultChars(block) {
  const content = block.content;
  if (typeof content === 'string') return content.length;
  if (Array.isArray(content)) {
    return content.reduce((total, part) => total + (part !== null && typeof part === 'object' && typeof part.text === 'string' ? part.text.length : 0), 0);
  }
  return 0;
}

/** MCP tool names look like mcp__<server>__<tool>; returns the server or null for built-in tools. */
export function mcpServerOf(toolName) {
  if (!toolName.startsWith('mcp__')) return null;
  const rest = toolName.slice('mcp__'.length);
  const end = rest.indexOf('__');
  return end > 0 ? rest.slice(0, end) : null;
}

function countToolCalls(order) {
  const byName = {};
  const byServer = {};
  let mcp = 0;
  for (const name of order) {
    byName[name] = (byName[name] ?? 0) + 1;
    const server = mcpServerOf(name);
    if (server !== null) {
      mcp += 1;
      byServer[server] = (byServer[server] ?? 0) + 1;
    }
  }
  return { total: order.length, mcp, builtin: order.length - mcp, byName, byServer, sequence: order };
}

/** Folds the event list of one run into metrics. */
export function summarizeStream(events) {
  let init = null;
  let result = null;
  const messageUsage = new Map();
  const messageOrder = [];
  const toolUses = new Map();
  const toolOrder = [];
  let resultCount = 0;
  let resultChars = 0;
  let resultErrors = 0;
  let subagentMessages = 0;

  for (const event of events) {
    if (event.type === 'system' && event.subtype === 'init' && init === null) {
      init = normalizeInit(event);
    } else if (event.type === 'assistant' && event.message !== null && typeof event.message === 'object') {
      const message = event.message;
      const id = typeof message.id === 'string' ? message.id : `anonymous-${messageOrder.length}`;
      if (!messageUsage.has(id)) {
        messageOrder.push(id);
        if (event.parent_tool_use_id) subagentMessages += 1;
      }
      messageUsage.set(id, maxUsage(messageUsage.get(id) ?? emptyUsage(), normalizeUsage(message.usage)));
      for (const block of Array.isArray(message.content) ? message.content : []) {
        if (block !== null && typeof block === 'object' && block.type === 'tool_use' && typeof block.name === 'string') {
          const key = typeof block.id === 'string' ? block.id : `${id}-${toolOrder.length}`;
          if (!toolUses.has(key)) {
            toolUses.set(key, block.name);
            toolOrder.push(block.name);
          }
        }
      }
    } else if (event.type === 'user' && event.message !== null && typeof event.message === 'object') {
      for (const block of Array.isArray(event.message.content) ? event.message.content : []) {
        if (block !== null && typeof block === 'object' && block.type === 'tool_result') {
          resultCount += 1;
          resultChars += toolResultChars(block);
          if (block.is_error === true) resultErrors += 1;
        }
      }
    } else if (event.type === 'result') {
      result = normalizeResult(event);
    }
  }

  const perMessage = messageOrder.map((id) => messageUsage.get(id));
  const messageTotals = perMessage.reduce(addUsage, emptyUsage());
  const first = perMessage[0];
  return {
    init,
    result,
    hasResult: result !== null,
    usage: result !== null ? result.usage : messageTotals,
    usageSource: result !== null ? 'result' : 'messages',
    messageUsageTotals: messageTotals,
    assistantMessages: messageOrder.length,
    subagentMessages,
    firstTurnContextTokens: first === undefined ? null : first.inputTokens + first.cacheCreationTokens + first.cacheReadTokens,
    toolCalls: countToolCalls(toolOrder),
    toolResults: { count: resultCount, chars: resultChars, errors: resultErrors },
  };
}
