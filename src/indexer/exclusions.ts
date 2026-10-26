import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import ignore, { type Ignore } from 'ignore';
import type { MaxifyConfig } from '../config/config.js';

/**
 * File classes:
 * - secret:  never read, never indexed, never served (by name or by content).
 * - ignored: excluded by defaults, .gitignore, .maxifyignore or config; not indexed or served.
 * - noise:   generated/lock/minified files; not indexed but servable on explicit request.
 * - ok:      indexed.
 */
export type FileClass = 'ok' | 'noise' | 'ignored' | 'secret';

export const DEFAULT_IGNORES: readonly string[] = [
  '.git/',
  '.hg/',
  '.svn/',
  'node_modules/',
  'bower_components/',
  'jspm_packages/',
  'dist/',
  'build/',
  'out/',
  'coverage/',
  '.nyc_output/',
  '.next/',
  '.nuxt/',
  '.svelte-kit/',
  '.turbo/',
  '.cache/',
  '.parcel-cache/',
  '.vercel/',
  '.netlify/',
  '.output/',
  '.yarn/',
  '.pnpm-store/',
  'vendor/',
  'target/',
  '__pycache__/',
  '.venv/',
  'venv/',
  '.tox/',
  '.gradle/',
  '.idea/',
  'graphify-out/',
  '.maxify/',
];

export const NOISE_PATTERNS: readonly string[] = [
  '*.min.js',
  '*.min.css',
  '*.map',
  '*.tsbuildinfo',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lock',
  'bun.lockb',
];

export const SECRET_PATTERNS: readonly string[] = [
  '.env',
  '.env.*',
  '!.env.example',
  '!.env.sample',
  '!.env.template',
  '!.env.defaults',
  '*.pem',
  '*.key',
  '*.p12',
  '*.pfx',
  '*.jks',
  '*.keystore',
  '*.kdbx',
  'id_rsa*',
  'id_dsa*',
  'id_ecdsa*',
  'id_ed25519*',
  '.npmrc',
  '.pypirc',
  '.netrc',
  '.git-credentials',
  '.htpasswd',
  'credentials.json',
  '*-credentials.json',
  'service-account*.json',
  'secrets.json',
  'secrets.yml',
  'secrets.yaml',
  '*.secret',
  '*.secrets',
  '*.tfstate',
  '*.tfstate.*',
  '*.tfvars',
  '.aws/',
  '.ssh/',
  '.gnupg/',
  '.docker/config.json',
];

const PRIVATE_KEY_MARKER = /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----/;

/** True if text contains a PEM private key block (treated as a secret file). */
export function containsPrivateKey(text: string): boolean {
  return PRIVATE_KEY_MARKER.test(text);
}

function readPatterns(file: string): string[] {
  if (!existsSync(file)) return [];
  try {
    return readFileSync(file, 'utf8').split(/\r?\n/);
  } catch {
    return [];
  }
}

export class Exclusions {
  private readonly root: string;
  private readonly config: MaxifyConfig;
  private readonly secret: Ignore;
  private readonly noise: Ignore;
  private readonly respectGitignore: boolean;
  private base: Ignore;
  /** Per-directory .gitignore matchers, keyed by directory rel path ('' = root). null = no file. */
  private readonly nested = new Map<string, Ignore | null>();

  constructor(root: string, config: MaxifyConfig) {
    this.root = root;
    this.config = config;
    this.respectGitignore = config.respectGitignore;
    this.secret = ignore().add([...SECRET_PATTERNS, ...config.extraSecretPatterns]);
    this.noise = ignore().add([...NOISE_PATTERNS]);
    this.base = this.loadBase();
  }

  private loadBase(): Ignore {
    return ignore().add([
      ...DEFAULT_IGNORES,
      ...this.config.exclude,
      ...readPatterns(path.join(this.root, '.maxifyignore')),
      ...readPatterns(path.join(this.root, '.git', 'info', 'exclude')),
    ]);
  }

  /** Re-read ignore files (called at the start of every index run so edits to .gitignore apply). */
  reload(): void {
    this.base = this.loadBase();
    this.nested.clear();
  }

  private gitignoreFor(dirRel: string): Ignore | null {
    const cached = this.nested.get(dirRel);
    if (cached !== undefined) return cached;
    const file = path.join(this.root, ...(dirRel === '' ? [] : dirRel.split('/')), '.gitignore');
    const patterns = readPatterns(file);
    const matcher = patterns.length > 0 ? ignore().add(patterns) : null;
    this.nested.set(dirRel, matcher);
    return matcher;
  }

  private gitignored(rel: string, isDir: boolean): boolean {
    if (!this.respectGitignore) return false;
    const parts = rel.split('/');
    for (let depth = 0; depth < parts.length; depth++) {
      const dirRel = parts.slice(0, depth).join('/');
      const matcher = this.gitignoreFor(dirRel);
      if (matcher === null) continue;
      const sub = parts.slice(depth).join('/');
      if (matcher.ignores(isDir ? `${sub}/` : sub)) return true;
    }
    return false;
  }

  /** Classify a POSIX path relative to root. Directories are checked with isDir=true. */
  classify(rel: string, isDir = false): FileClass {
    if (rel === '') return 'ok';
    const probe = isDir ? `${rel}/` : rel;
    if (this.secret.ignores(probe)) return 'secret';
    if (this.base.ignores(probe)) return 'ignored';
    if (this.gitignored(rel, isDir)) return 'ignored';
    if (!isDir && this.noise.ignores(probe)) return 'noise';
    return 'ok';
  }

  /** Classify a path including all ancestor directories (for direct requests like maxify_source). */
  classifyWithAncestors(rel: string): FileClass {
    const parts = rel.split('/');
    for (let i = 1; i < parts.length; i++) {
      const dirClass = this.classify(parts.slice(0, i).join('/'), true);
      if (dirClass !== 'ok') return dirClass;
    }
    return this.classify(rel, false);
  }
}
