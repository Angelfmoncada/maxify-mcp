import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MaxifyError } from '../../src/core/errors.js';
import { decodeText, readStreamText, readTextFile } from '../../src/cli/input.js';

describe('decodeText', () => {
  it('decodes plain UTF-8', () => {
    expect(decodeText(Buffer.from('héllo ✓', 'utf8'))).toBe('héllo ✓');
  });

  it('strips a UTF-8 byte-order mark', () => {
    expect(decodeText(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('abc')]))).toBe('abc');
  });

  it('decodes UTF-16LE when a BOM says so (Windows PowerShell pipes)', () => {
    const body = Buffer.from('line one\r\nline two', 'utf16le');
    expect(decodeText(Buffer.concat([Buffer.from([0xff, 0xfe]), body]))).toBe('line one\r\nline two');
  });

  it('handles empty input', () => {
    expect(decodeText(new Uint8Array())).toBe('');
  });
});

describe('readStreamText', () => {
  it('joins chunks, including multi-byte characters split across chunks', async () => {
    const bytes = Buffer.from('añb€c', 'utf8');
    const stream = Readable.from([bytes.subarray(0, 2), bytes.subarray(2, 6), bytes.subarray(6)]);
    expect(await readStreamText(stream, 1024)).toBe('añb€c');
  });

  it('accepts string chunks', async () => {
    expect(await readStreamText(Readable.from(['ab', 'cd']), 1024)).toBe('abcd');
  });

  it('refuses input over the limit', async () => {
    await expect(readStreamText(Readable.from([Buffer.alloc(20)]), 10)).rejects.toThrow(/larger than/);
  });
});

describe('readTextFile', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'maxify-input-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads a file', () => {
    const file = path.join(dir, 'a.log');
    writeFileSync(file, 'hello\n');
    expect(readTextFile(file, 1024)).toBe('hello\n');
  });

  it('reports a missing file as NOT_FOUND', () => {
    expect.assertions(2);
    try {
      readTextFile(path.join(dir, 'nope.log'), 1024);
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(MaxifyError);
      expect((error as MaxifyError).code).toBe('NOT_FOUND');
    }
  });

  it('refuses directories', () => {
    expect(() => readTextFile(dir, 1024)).toThrow(/not a regular file/);
  });

  it('refuses files over the limit', () => {
    const file = path.join(dir, 'big.log');
    writeFileSync(file, 'x'.repeat(100));
    expect(() => readTextFile(file, 50)).toThrow(/larger than/);
  });
});
