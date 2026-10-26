import { DEFAULT_TOKEN_TTL_SECONDS } from '../shared/constants.ts';

export type Environment = 'development' | 'test' | 'production';

export interface ServerConfig {
  env: Environment;
  port: number;
  /** HMAC secret used to sign bearer tokens. Required in production. */
  tokenSecret: string;
  tokenTtlSeconds: number;
  /** Names of built-in plugins to enable, in load order. */
  plugins: string[];
}

const DEV_TOKEN_SECRET = 'dev-only-secret-change-me';

function parseInteger(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, received "${raw}"`);
  }
  return value;
}

function parseEnvironment(raw: string | undefined): Environment {
  if (raw === undefined || raw === '') return 'development';
  if (raw === 'development' || raw === 'test' || raw === 'production') return raw;
  throw new Error(`NODE_ENV must be development, test or production, received "${raw}"`);
}

function parseList(raw: string | undefined, fallback: string[]): string[] {
  if (raw === undefined) return fallback;
  return raw
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

/**
 * Builds the server configuration from environment variables.
 * In production TOKEN_SECRET must be set; other environments fall back to a development secret.
 */
export function loadConfig(env: Record<string, string | undefined> = process.env): ServerConfig {
  const environment = parseEnvironment(env.NODE_ENV);
  const secret = env.TOKEN_SECRET;
  if (environment === 'production' && (secret === undefined || secret.length < 16)) {
    throw new Error('TOKEN_SECRET must be set to at least 16 characters in production');
  }
  return {
    env: environment,
    port: parseInteger('PORT', env.PORT, 3000),
    tokenSecret: secret !== undefined && secret !== '' ? secret : DEV_TOKEN_SECRET,
    tokenTtlSeconds: parseInteger('TOKEN_TTL_SECONDS', env.TOKEN_TTL_SECONDS, DEFAULT_TOKEN_TTL_SECONDS),
    plugins: parseList(env.PLUGINS, ['audit-log']),
  };
}
