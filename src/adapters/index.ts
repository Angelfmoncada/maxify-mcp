/**
 * Adapter registry. `adapterFor` picks the adapter for a relative path:
 * exact file names first (e.g. package.json), then the extension. Unknown
 * and binary extensions get null.
 */
import type { LanguageAdapter } from '../core/types.js';
import { jsonAdapter } from './json.js';
import { markdownAdapter } from './markdown.js';
import { baseName, extensionOf } from './shared.js';
import { textAdapter } from './text.js';
import { typescriptAdapter } from './typescript.js';

export { isTestPath, testTargetCandidates } from './test-paths.js';

/** Bump when adapter output changes; the indexer re-parses every file when it does. */
export const ADAPTER_VERSION = '1';

export const ADAPTERS: readonly LanguageAdapter[] = [typescriptAdapter, markdownAdapter, jsonAdapter, textAdapter];

function registry(select: (adapter: LanguageAdapter) => readonly string[]): ReadonlyMap<string, LanguageAdapter> {
  const map = new Map<string, LanguageAdapter>();
  for (const adapter of ADAPTERS) {
    for (const key of select(adapter)) if (!map.has(key)) map.set(key, adapter);
  }
  return map;
}

const BY_FILE_NAME = registry((adapter) => adapter.fileNames ?? []);
const BY_EXTENSION = registry((adapter) => adapter.extensions);

/** Adapter for a relative POSIX path, or null for unknown/binary files. */
export function adapterFor(relPath: string): LanguageAdapter | null {
  return BY_FILE_NAME.get(baseName(relPath)) ?? BY_EXTENSION.get(extensionOf(relPath)) ?? null;
}
