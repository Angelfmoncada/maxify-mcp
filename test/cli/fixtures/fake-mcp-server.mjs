// Minimal stdio MCP server used to test `maxify doctor`'s self-test client.
// Usage: node fake-mcp-server.mjs <mode>
//   ok      six tools, maxify_stats answers
//   few     five tools
//   error   six tools, maxify_stats returns isError
//   crash   writes to stderr and exits before answering
//   hang    never answers
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const mode = process.argv[2] ?? 'ok';

if (mode === 'crash') {
  process.stderr.write('fixture: cannot open the index\n');
  process.exit(3);
}
if (mode === 'hang') {
  setInterval(() => undefined, 1000);
} else {
  const names = ['maxify_context', 'maxify_source', 'maxify_impact', 'maxify_compress', 'maxify_memory', 'maxify_stats'];
  const server = new McpServer({ name: 'fixture', version: '0.0.0' });
  for (const name of mode === 'few' ? names.slice(0, 5) : names) {
    server.registerTool(name, { description: name }, async () => {
      if (name === 'maxify_stats' && mode === 'error') {
        return { content: [{ type: 'text', text: 'index is locked' }], isError: true };
      }
      return { content: [{ type: 'text', text: `${name} ok` }] };
    });
  }
  await server.connect(new StdioServerTransport());
}
