import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { ValidationError } from '../shared/validation.ts';
import { createApp, startPlugins } from './app.ts';
import type { App } from './app.ts';
import { errorResponse } from './http/responses.ts';
import type { HttpResponse } from './http/types.ts';

/** Reads and parses a JSON request body. Returns undefined for an empty body. */
async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new ValidationError([{ field: 'body', message: 'must be valid JSON' }]);
  }
}

function writeResponse(res: ServerResponse, response: HttpResponse): void {
  const payload =
    response.body === undefined || typeof response.body === 'string'
      ? (response.body ?? '')
      : JSON.stringify(response.body);
  res.writeHead(response.status, response.headers);
  res.end(payload);
}

/** Adapts the transport-agnostic app to Node's http module. */
export function toNodeListener(app: App): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    try {
      const body = await readJsonBody(req);
      const headers: Record<string, string | undefined> = {};
      for (const [name, value] of Object.entries(req.headers)) {
        headers[name] = Array.isArray(value) ? value.join(', ') : value;
      }
      writeResponse(res, await app.handle({ method: req.method ?? 'GET', url: req.url ?? '/', headers, body }));
    } catch (error: unknown) {
      writeResponse(res, errorResponse(error));
    }
  };
}

async function main(): Promise<void> {
  const app = createApp();
  await startPlugins(app);
  const server = createServer((req, res) => void toNodeListener(app)(req, res));
  server.listen(app.config.port, () => {
    app.logger.info('server listening', { port: app.config.port });
  });
}

main().catch((error: unknown) => {
  process.stderr.write(`fatal: ${String(error)}\n`);
  process.exitCode = 1;
});
