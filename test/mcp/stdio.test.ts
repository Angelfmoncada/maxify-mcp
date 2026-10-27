import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { redirectConsoleToStderr, serveStdio, type ServeHandle } from '../../src/mcp/stdio.js';
import { EMPTY_SUMMARY, createFakeEngine } from './helpers.js';

interface Harness {
  stdin: PassThrough;
  stdout: PassThrough;
  signals: EventEmitter;
  exit: ReturnType<typeof vi.fn<(code: number) => void>>;
  frames: unknown[];
  raw: string[];
  send(message: unknown): void;
  nextFrame(id: number): Promise<Record<string, unknown>>;
}

function createHarness(): Harness {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const raw: string[] = [];
  const frames: unknown[] = [];
  const waiters = new Map<number, (frame: Record<string, unknown>) => void>();
  let buffer = '';
  stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      raw.push(line);
      const frame = JSON.parse(line) as Record<string, unknown>;
      frames.push(frame);
      const id = typeof frame.id === 'number' ? frame.id : undefined;
      if (id !== undefined) waiters.get(id)?.(frame);
      newline = buffer.indexOf('\n');
    }
  });
  return {
    stdin,
    stdout,
    signals: new EventEmitter(),
    exit: vi.fn<(code: number) => void>(),
    frames,
    raw,
    send: (message) => void stdin.write(`${JSON.stringify(message)}\n`),
    nextFrame: (id) =>
      new Promise((resolve) => {
        const existing = frames.find((frame) => (frame as { id?: number }).id === id);
        if (existing) resolve(existing as Record<string, unknown>);
        else waiters.set(id, resolve);
      }),
  };
}

describe('serveStdio', () => {
  let harness: Harness;
  let handle: ServeHandle | undefined;
  let stderr: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    harness = createHarness();
    stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });
  afterEach(() => {
    handle?.shutdown('test cleanup');
    handle = undefined;
    vi.restoreAllMocks();
  });

  const start = (engine = createFakeEngine().engine, extra: Record<string, unknown> = {}): Promise<ServeHandle> =>
    serveStdio(engine, {
      version: '9.9.9',
      cliCommand: 'maxify',
      stdin: harness.stdin,
      stdout: harness.stdout,
      signals: harness.signals,
      exit: harness.exit,
      redirectConsole: false,
      ...extra,
    });

  it('speaks MCP over the streams and writes only JSON-RPC frames to stdout', async () => {
    handle = await start();
    harness.send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } },
    });
    const init = (await harness.nextFrame(1)) as { result: { serverInfo: { name: string; version: string }; instructions: string } };
    expect(init.result.serverInfo).toEqual({ name: 'maxify', version: '9.9.9' });
    expect(init.result.instructions).toContain('maxify_context');
    harness.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    harness.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const list = (await harness.nextFrame(2)) as { result: { tools: Array<{ name: string }> } };
    expect(list.result.tools).toHaveLength(6);
    harness.send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'maxify_stats', arguments: {} } });
    const call = (await harness.nextFrame(3)) as { result: { content: Array<{ text: string }> } };
    expect(call.result.content[0]?.text).toBe('stats ok');
    for (const line of harness.raw) expect(() => JSON.parse(line)).not.toThrow();
  });

  it('starts the index after connecting without waiting for it', async () => {
    const index = vi.fn(() => new Promise<never>(() => undefined));
    handle = await start(createFakeEngine({ index }).engine);
    expect(index).toHaveBeenCalledTimes(1);
  });

  it('logs index results and failures to stderr', async () => {
    handle = await start(createFakeEngine({ index: async () => ({ ...EMPTY_SUMMARY, errors: ['bad file'] }) }).engine);
    await vi.waitFor(() => expect(stderrText(stderr)).toContain('index: bad file'));
    handle.shutdown('done');
    handle = undefined;

    const failing = createHarness();
    const failingHandle = await serveStdio(
      createFakeEngine({
        index: async () => {
          throw new Error('disk gone');
        },
      }).engine,
      { version: '1', cliCommand: 'maxify', stdin: failing.stdin, stdout: failing.stdout, signals: failing.signals, exit: failing.exit, redirectConsole: false },
    );
    await vi.waitFor(() => expect(stderrText(stderr)).toContain('initial index failed: disk gone'));
    failingHandle.shutdown('done');
  });

  it('can skip the initial index', async () => {
    const index = vi.fn(async () => EMPTY_SUMMARY);
    handle = await start(createFakeEngine({ index }).engine, { index: false });
    expect(index).not.toHaveBeenCalled();
  });

  it('closes the engine synchronously and exits when stdin ends', async () => {
    const fake = createFakeEngine();
    handle = await start(fake.engine);
    harness.stdin.end();
    await handle.closed;
    expect(fake.engine.close).toHaveBeenCalledTimes(1);
    expect(harness.exit).toHaveBeenCalledTimes(1);
    expect(harness.exit).toHaveBeenCalledWith(0);
  });

  it('closes the engine and exits inside the stdin end event itself, with no await in between', async () => {
    // Claude Code may kill the process tree ~300 ms after closing stdin (Windows): nothing may be deferred.
    const fake = createFakeEngine();
    handle = await start(fake.engine);
    harness.stdin.emit('end');
    expect(fake.engine.close).toHaveBeenCalledTimes(1);
    expect(harness.exit).toHaveBeenCalledWith(0);
  });

  it('exits with a failure code when the transport dies from a framing error (oversized message)', async () => {
    const fake = createFakeEngine();
    handle = await start(fake.engine);
    harness.stdin.write('x'.repeat(11 * 1024 * 1024));
    await vi.waitFor(() => expect(harness.exit).toHaveBeenCalledWith(1));
    expect(fake.engine.close).toHaveBeenCalledTimes(1);
    expect(stderrText(stderr)).toContain('transport error');
  });

  it.each(['SIGINT', 'SIGTERM'])('shuts down once on %s', async (signal) => {
    const fake = createFakeEngine();
    handle = await start(fake.engine);
    harness.signals.emit(signal);
    harness.signals.emit('SIGINT');
    harness.stdin.end();
    await handle.closed;
    expect(fake.engine.close).toHaveBeenCalledTimes(1);
    expect(harness.exit).toHaveBeenCalledTimes(1);
  });

  it('still exits when closing the engine throws', async () => {
    const close = vi.fn(() => {
      throw new Error('locked');
    });
    handle = await start(createFakeEngine({ close }).engine);
    handle.shutdown('manual', 3);
    expect(harness.exit).toHaveBeenCalledWith(3);
    expect(stderrText(stderr)).toContain('closing the engine failed: locked');
  });

  it('exits non-zero when stdout fails (client gone)', async () => {
    handle = await start();
    harness.stdout.emit('error', new Error('EPIPE'));
    expect(harness.exit).toHaveBeenCalledWith(1);
  });
});

function stderrText(spy: { mock: { calls: unknown[][] } }): string {
  return spy.mock.calls.map((call) => String(call[0])).join('');
}

describe('redirectConsoleToStderr', () => {
  const methods = ['log', 'info', 'debug', 'dir', 'dirxml', 'table'] as const;

  function collector(): { target: Writable; text(): string } {
    const chunks: string[] = [];
    const target = new Writable({
      write(chunk: Buffer, _encoding, done) {
        chunks.push(chunk.toString('utf8'));
        done();
      },
    });
    return { target, text: () => chunks.join('') };
  }

  it('sends every stdout-writing console method to the target and restores the originals', () => {
    const originals = methods.map((method) => console[method]);
    const { target, text } = collector();
    const restore = redirectConsoleToStderr(target);
    console.log('hello %s', 'world', { a: 1 });
    console.info('info');
    console.debug('debug');
    console.dir({ deep: { x: 1 } });
    console.table([{ col: 'cell' }]);
    restore();
    const written = text();
    expect(written).toContain("hello world { a: 1 }\n");
    expect(written).toContain('info\n');
    expect(written).toContain('debug\n');
    expect(written).toContain('deep');
    expect(written).toContain('cell');
    methods.forEach((method, index) => expect(console[method], method).toBe(originals[index]));
  });

  it('defaults to stderr, so stdout stays clean', () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const restore = redirectConsoleToStderr();
    try {
      console.log('to stderr');
      expect(stdout).not.toHaveBeenCalled();
      expect(String(stderr.mock.calls[0]?.[0])).toBe('to stderr\n');
    } finally {
      restore();
      stdout.mockRestore();
      stderr.mockRestore();
    }
  });
});
