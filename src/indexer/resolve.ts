import { builtinModules } from 'node:module';
import path from 'node:path';
import ts from 'typescript';
import type { RepoGuard } from '../core/paths.js';
import type { ImportKind } from '../core/types.js';

/**
 * - resolved:   target is an indexed file in this repository (static resolution => provenance 'resolved').
 * - excluded:   target is inside the root but not indexed (ignored/noise/too large).
 * - external:   package, Node builtin, or outside the root.
 * - unresolved: relative/alias specifier that could not be resolved (reported as an uncertainty).
 */
export type Resolution = 'resolved' | 'excluded' | 'external' | 'unresolved';

export interface ResolveResult {
  resolution: Resolution;
  resolvedPath: string | null;
}

const CONFIG_NAMES = new Set(['tsconfig.json', 'jsconfig.json']);
const BUILTINS = new Set(builtinModules);

const DEFAULT_OPTIONS: ts.CompilerOptions = {
  allowJs: true,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  target: ts.ScriptTarget.ES2022,
  jsx: ts.JsxEmit.Preserve,
  resolveJsonModule: true,
  allowImportingTsExtensions: true,
  noEmit: true,
};

export function isConfigFile(rel: string): boolean {
  return CONFIG_NAMES.has(path.posix.basename(rel));
}

function isRelativeSpec(spec: string): boolean {
  return spec === '.' || spec === '..' || spec.startsWith('./') || spec.startsWith('../') || spec.startsWith('/');
}

/** One resolver per index run: its filesystem memo assumes the file set does not change during the run. */
export class ModuleResolver {
  private readonly guard: RepoGuard;
  private readonly configFiles: ReadonlySet<string>;
  private readonly nearestConfig = new Map<string, string | null>();
  private readonly options = new Map<string, ts.CompilerOptions>();
  private readonly caches = new Map<string, ts.ModuleResolutionCache>();
  private readonly existsMemo = new Map<string, boolean>();
  private readonly dirMemo = new Map<string, boolean>();
  private readonly host: ts.ModuleResolutionHost;

  constructor(guard: RepoGuard, configFiles: Iterable<string>) {
    this.guard = guard;
    this.configFiles = new Set(configFiles);
    this.host = {
      fileExists: (file) => this.memo(this.existsMemo, file, () => ts.sys.fileExists(file)),
      directoryExists: (dir) => this.memo(this.dirMemo, dir, () => ts.sys.directoryExists(dir)),
      readFile: (file) => ts.sys.readFile(file),
      realpath: ts.sys.realpath ? (p) => (ts.sys.realpath as (x: string) => string)(p) : undefined,
      getCurrentDirectory: () => guard.root,
      useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
    };
  }

  private memo(map: Map<string, boolean>, key: string, compute: () => boolean): boolean {
    const hit = map.get(key);
    if (hit !== undefined) return hit;
    const value = compute();
    map.set(key, value);
    return value;
  }

  private configFor(fromRel: string): string | null {
    let dir = path.posix.dirname(fromRel);
    const visited: string[] = [];
    let found: string | null = null;
    for (;;) {
      const key = dir === '.' ? '' : dir;
      const cached = this.nearestConfig.get(key);
      if (cached !== undefined) {
        found = cached;
        break;
      }
      visited.push(key);
      const candidates = ['tsconfig.json', 'jsconfig.json'].map((n) => (key === '' ? n : `${key}/${n}`));
      const hit = candidates.find((c) => this.configFiles.has(c));
      if (hit) {
        found = hit;
        break;
      }
      if (key === '') break;
      dir = path.posix.dirname(key);
    }
    for (const key of visited) this.nearestConfig.set(key, found);
    return found;
  }

  private optionsFor(configRel: string | null): { key: string; options: ts.CompilerOptions } {
    const key = configRel ?? '<default>';
    const cached = this.options.get(key);
    if (cached) return { key, options: cached };
    let options = DEFAULT_OPTIONS;
    if (configRel !== null) {
      const parsed = ts.getParsedCommandLineOfConfigFile(this.guard.abs(configRel), {}, {
        ...ts.sys,
        onUnRecoverableConfigFileDiagnostic: () => undefined,
      });
      if (parsed) {
        const own = parsed.options;
        const moduleResolution =
          own.moduleResolution === undefined || own.moduleResolution === ts.ModuleResolutionKind.Classic
            ? ts.ModuleResolutionKind.Bundler
            : own.moduleResolution;
        options = { ...own, allowJs: true, resolveJsonModule: true, moduleResolution };
      }
    }
    this.options.set(key, options);
    return { key, options };
  }

  private cacheFor(key: string, options: ts.CompilerOptions): ts.ModuleResolutionCache {
    let cache = this.caches.get(key);
    if (!cache) {
      const canonical = (f: string): string => (ts.sys.useCaseSensitiveFileNames ? f : f.toLowerCase());
      cache = ts.createModuleResolutionCache(this.guard.root, canonical, options);
      this.caches.set(key, cache);
    }
    return cache;
  }

  /** Resolve a markdown link target relative to the document. */
  private resolveDocLink(spec: string, fromRel: string, isIndexed: (rel: string) => boolean): ResolveResult {
    let decoded = spec;
    try {
      decoded = decodeURI(spec);
    } catch {
      decoded = spec;
    }
    const joined = path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), decoded));
    if (joined.startsWith('..') || path.posix.isAbsolute(joined)) return { resolution: 'external', resolvedPath: null };
    const rel = joined.replace(/\/$/, '');
    if (isIndexed(rel)) return { resolution: 'resolved', resolvedPath: rel };
    const exists = ts.sys.fileExists(this.guard.abs(rel)) || ts.sys.directoryExists(this.guard.abs(rel));
    return exists ? { resolution: 'excluded', resolvedPath: rel } : { resolution: 'unresolved', resolvedPath: null };
  }

  resolve(spec: string, fromRel: string, kind: ImportKind, language: string, isIndexed: (rel: string) => boolean): ResolveResult {
    if (language === 'markdown') return this.resolveDocLink(spec, fromRel, isIndexed);
    if (spec.startsWith('node:') || BUILTINS.has(spec)) return { resolution: 'external', resolvedPath: null };
    const { key, options } = this.optionsFor(this.configFor(fromRel));
    const mode = kind === 'require' ? ts.ModuleKind.CommonJS : undefined;
    let result: ts.ResolvedModuleWithFailedLookupLocations;
    try {
      result = ts.resolveModuleName(spec, this.guard.abs(fromRel), options, this.host, this.cacheFor(key, options), undefined, mode);
    } catch {
      return { resolution: 'unresolved', resolvedPath: null };
    }
    const resolved = result.resolvedModule;
    if (!resolved) {
      const looksLocal = isRelativeSpec(spec) || this.matchesPathAlias(spec, options);
      return { resolution: looksLocal ? 'unresolved' : 'external', resolvedPath: null };
    }
    const file = path.resolve(resolved.resolvedFileName);
    const rel = this.guard.relIfInside(file);
    if (rel === null || resolved.isExternalLibraryImport || rel.split('/').includes('node_modules')) {
      return { resolution: 'external', resolvedPath: null };
    }
    return isIndexed(rel) ? { resolution: 'resolved', resolvedPath: rel } : { resolution: 'excluded', resolvedPath: rel };
  }

  private matchesPathAlias(spec: string, options: ts.CompilerOptions): boolean {
    const paths = options.paths;
    if (!paths) return false;
    return Object.keys(paths).some((pattern) => {
      const star = pattern.indexOf('*');
      if (star < 0) return pattern === spec;
      return spec.startsWith(pattern.slice(0, star)) && spec.endsWith(pattern.slice(star + 1));
    });
  }
}
