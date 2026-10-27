import { readFileSync, statSync } from 'node:fs';
import { MaxifyError } from '../core/errors.js';
import type { RepoGuard } from '../core/paths.js';
import { containsPrivateKey, type Exclusions, type FileClass } from './exclusions.js';

/** Hard cap for any single file Maxify reads on request (pagination handles display). */
export const MAX_READ_BYTES = 20 * 1024 * 1024;

export interface SafeFile {
  rel: string;
  buffer: Buffer;
  text: string;
}

function worst(a: FileClass, b: FileClass): FileClass {
  const rank: Record<FileClass, number> = { ok: 0, noise: 1, ignored: 2, secret: 3 };
  return rank[a] >= rank[b] ? a : b;
}

/**
 * The only way request handlers read repository files. Classifies both the
 * requested path and its real (symlink-resolved) path, so `docs/x -> ../.env`
 * is refused; requires a regular file under the size cap; refuses binary
 * content and PEM private keys found in the bytes.
 */
export function readRepoText(guard: RepoGuard, exclusions: Exclusions, rel: string, ignoredHint = ''): SafeFile {
  const real = guard.realRel(rel);
  if (real === null) throw new MaxifyError('NOT_FOUND', `${rel} does not exist on disk (it may have been deleted or renamed).`);
  const lexicalClass = exclusions.classifyWithAncestors(rel);
  const cls = real === rel ? lexicalClass : worst(lexicalClass, exclusions.classifyWithAncestors(real));
  if (cls === 'secret') throw new MaxifyError('EXCLUDED', `${rel} is classified as a secret file; Maxify never reads it.`);
  if (cls === 'ignored') {
    throw new MaxifyError('EXCLUDED', `${rel} is excluded (.gitignore/.maxifyignore/config/defaults); Maxify does not serve it.${ignoredHint}`);
  }
  const abs = guard.abs(real);
  const stat = statSync(abs);
  if (!stat.isFile()) throw new MaxifyError('INVALID_INPUT', `${rel} is not a regular file.`);
  if (stat.size > MAX_READ_BYTES) throw new MaxifyError('INVALID_INPUT', `${rel} is larger than ${MAX_READ_BYTES / 1024 / 1024} MB.`);
  const buffer = readFileSync(abs);
  if (buffer.subarray(0, 8192).includes(0)) throw new MaxifyError('INVALID_INPUT', `${rel} is a binary file.`);
  const text = buffer.toString('utf8');
  if (containsPrivateKey(text)) throw new MaxifyError('EXCLUDED', `${rel} contains a private key; Maxify never serves it.`);
  return { rel, buffer, text };
}
