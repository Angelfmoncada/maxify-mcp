/** Reading text input (stdin or files) with a size cap and byte-order-mark handling. */
import { readFileSync, statSync } from 'node:fs';
import type { Readable } from 'node:stream';
import { MaxifyError } from '../core/errors.js';

/** Largest input the CLI accepts (compress). Bigger inputs should be filtered first. */
export const MAX_INPUT_BYTES = 64 * 1024 * 1024;

/** Decode bytes as text: UTF-8 (BOM stripped) or UTF-16LE when a BOM says so (Windows PowerShell pipes). */
export function decodeText(bytes: Uint8Array): string {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) return buffer.subarray(2).toString('utf16le');
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return buffer.subarray(3).toString('utf8');
  }
  return buffer.toString('utf8');
}

function tooLarge(what: string, maxBytes: number): MaxifyError {
  return new MaxifyError(
    'INVALID_INPUT',
    `${what} is larger than ${Math.floor(maxBytes / (1024 * 1024))} MB. Filter it first (for example with grep or tail).`,
  );
}

export async function readStreamText(stream: Readable, maxBytes: number): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : (chunk as Buffer);
    total += buffer.length;
    if (total > maxBytes) throw tooLarge('stdin', maxBytes);
    chunks.push(buffer);
  }
  return decodeText(Buffer.concat(chunks));
}

export function readTextFile(file: string, maxBytes: number): string {
  let size: number;
  try {
    const stats = statSync(file);
    if (!stats.isFile()) throw new MaxifyError('INVALID_INPUT', `${file} is not a regular file.`);
    size = stats.size;
  } catch (error: unknown) {
    if (error instanceof MaxifyError) throw error;
    throw new MaxifyError('NOT_FOUND', `Cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (size > maxBytes) throw tooLarge(file, maxBytes);
  return decodeText(readFileSync(file));
}
