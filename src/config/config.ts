import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { MaxifyError } from '../core/errors.js';
import { sha256, stableStringify } from '../core/hash.js';
import { DEFAULT_CONTEXT_BUDGET, MAX_BUDGET, MIN_BUDGET } from '../engine/types.js';
import { DEFAULT_COMPRESS_MAX_TOKENS } from '../compress/types.js';

export const CONFIG_FILE = 'maxify.config.json';

export interface MaxifyConfig {
  /** Extra gitignore-style patterns excluded from indexing and from maxify_source. */
  exclude: string[];
  respectGitignore: boolean;
  /** Files larger than this are listed but not parsed or served. */
  maxFileBytes: number;
  /** Extra gitignore-style patterns treated as secrets (never read). */
  extraSecretPatterns: string[];
  context: {
    defaultBudget: number;
    includeTests: boolean;
    /** Delta responses (omit evidence already sent this session). Off by default. */
    delta: boolean;
  };
  compress: {
    blobTtlDays: number;
    maxStoreMB: number;
    defaultMaxTokens: number;
  };
}

export const DEFAULT_CONFIG: MaxifyConfig = {
  exclude: [],
  respectGitignore: true,
  maxFileBytes: 1_000_000,
  extraSecretPatterns: [],
  context: {
    defaultBudget: DEFAULT_CONTEXT_BUDGET,
    includeTests: true,
    delta: false,
  },
  compress: {
    blobTtlDays: 7,
    maxStoreMB: 200,
    defaultMaxTokens: DEFAULT_COMPRESS_MAX_TOKENS,
  },
};

const partialConfigSchema = z
  .object({
    $schema: z.string().optional(),
    exclude: z.array(z.string().min(1)).max(500).optional(),
    respectGitignore: z.boolean().optional(),
    maxFileBytes: z.number().int().min(1024).max(50_000_000).optional(),
    extraSecretPatterns: z.array(z.string().min(1)).max(200).optional(),
    context: z
      .object({
        defaultBudget: z.number().int().min(MIN_BUDGET).max(MAX_BUDGET).optional(),
        includeTests: z.boolean().optional(),
        delta: z.boolean().optional(),
      })
      .strict()
      .optional(),
    compress: z
      .object({
        blobTtlDays: z.number().min(0.01).max(365).optional(),
        maxStoreMB: z.number().min(1).max(10_000).optional(),
        defaultMaxTokens: z.number().int().min(200).max(MAX_BUDGET).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export interface LoadedConfig {
  config: MaxifyConfig;
  /** Hash of the effective config; part of every cache key. */
  hash: string;
  /** Absolute path of the config file, or null when defaults are used. */
  source: string | null;
}

export function configHash(config: MaxifyConfig): string {
  return sha256(stableStringify(config)).slice(0, 16);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Load `<root>/maxify.config.json` (or `explicitPath`), validate it, and merge it over defaults. */
export function loadConfig(root: string, explicitPath?: string): LoadedConfig {
  const file = explicitPath ? path.resolve(explicitPath) : path.join(root, CONFIG_FILE);
  if (!existsSync(file)) {
    if (explicitPath) throw new MaxifyError('NOT_FOUND', `Config file not found: ${file}`);
    return { config: DEFAULT_CONFIG, hash: configHash(DEFAULT_CONFIG), source: null };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error: unknown) {
    throw new MaxifyError('INVALID_INPUT', `Invalid JSON in ${file}: ${errorMessage(error)}`);
  }
  const parsed = partialConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new MaxifyError('INVALID_INPUT', `Invalid ${CONFIG_FILE}: ${z.prettifyError(parsed.error)}`);
  }
  const partial = parsed.data;
  const config: MaxifyConfig = {
    exclude: partial.exclude ?? DEFAULT_CONFIG.exclude,
    respectGitignore: partial.respectGitignore ?? DEFAULT_CONFIG.respectGitignore,
    maxFileBytes: partial.maxFileBytes ?? DEFAULT_CONFIG.maxFileBytes,
    extraSecretPatterns: partial.extraSecretPatterns ?? DEFAULT_CONFIG.extraSecretPatterns,
    context: { ...DEFAULT_CONFIG.context, ...partial.context },
    compress: { ...DEFAULT_CONFIG.compress, ...partial.compress },
  };
  return { config, hash: configHash(config), source: file };
}
