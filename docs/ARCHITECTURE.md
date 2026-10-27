# Architecture

Maxify is a local, deterministic pipeline: **index → retrieve → budget → verify → render**.
No network access, no API keys, no embeddings, no LLM calls.

```
                ┌──────────── maxify CLI ─────────────┐   ┌──── maxify serve (stdio MCP) ────┐
                │ init index query source impact      │   │ 6 tools + server instructions    │
                │ compress memory stats bench doctor  │   │ stdout = JSON-RPC only           │
                └──────────────────┬──────────────────┘   └────────────────┬─────────────────┘
                                   └──────────────┬───────────────────────┘
                                         Engine facade (src/engine)
             ┌──────────────┬────────────────┬────┴──────────┬───────────────┬──────────────┐
         indexer        retrieval         compress         memory          stats/metrics
     walk + exclusions  context compiler  pure transforms  anchored notes   local only
     adapters (pure)    source / impact   + blob store
     module resolution  graph queries
             └──────────────┴──────── SQLite (node:sqlite, FTS5) per repository root ────────┘
```

## Modules

| Path | Responsibility |
|---|---|
| `src/core` | Shared contracts (`types.ts`), token estimator, path guard, state dir, errors, logging. |
| `src/adapters` | Pure language adapters: TS/JS (TypeScript Compiler API, syntax only), Markdown, JSON, generic text chunks. |
| `src/indexer` | Repository walk with exclusions, incremental indexing by size/mtime then content hash, rename detection, static module resolution (`ts.resolveModuleName` with each file's nearest tsconfig/jsconfig). |
| `src/store` | SQLite schema and data access: files, symbols, imports, refs, uncertainties, FTS, notes, blobs, cache, metrics. |
| `src/retrieval` | Task analysis, candidate ranking, graph expansion, budget planning, rendering, exact source, impact. |
| `src/compress` | Recoverable compression of logs, test runs, search results, JSON, listings and diffs. Pure functions. |
| `src/memory` | Small notes with provenance, anchored to file hashes for staleness. |
| `src/engine` | Facade used by the MCP server, the CLI and benchmarks; validation, freshness, caching, metrics. |
| `src/mcp`, `src/cli` | Transport and user interfaces. |
| `src/bench`, `bench/` | Offline benchmark, fixtures, task suites, agent benchmark harness. |

## Indexing

1. Walk the root. Secret files (by name, e.g. `.env`, `*.pem`, and by content, PEM private keys) are never read. Ignored paths (defaults such as `node_modules/`, `.gitignore` files at every level, `.git/info/exclude`, `.maxifyignore`, config `exclude`) are pruned before descending. Lockfiles and minified files are *noise*: listed, not parsed. Symlinked directories are not followed; symlinked files are kept only if their real path stays inside the root.
2. Compare each file's size and mtime with the index. Only changed files are read and hashed (SHA-256); only files whose hash changed are parsed.
3. Adapters return symbols with exact line spans, derived signatures, docs, exports, imports, same-file references and *uncertainties* (dynamic `import()`/`require()` with non-literal specifiers, computed calls, `eval`, glob imports, parse errors).
4. Deleted files are removed; a deleted file whose hash matches a new file is recorded as a **rename** and notes follow it.
5. Imports are resolved statically. When the set of files or a tsconfig/package.json changes, every non-external import is re-resolved; otherwise only imports of changed files.
6. Every change bumps the index **generation**, which versions evidence and cache entries.

Each repository root gets its own state directory outside the repository (`%LOCALAPPDATA%\maxify\repos\<name>-<hash>` on Windows, `~/Library/Caches/maxify/...` on macOS, `$XDG_CACHE_HOME/maxify/...` on Linux), so worktrees and copies never share an index, and indexes are not committed or synced. A state dir reused for another root is reset.

## Relations and provenance

| Provenance | Meaning | Example |
|---|---|---|
| `extracted` | Present in one file's syntax. | `verifyToken` calls `isExpired` in the same file. |
| `resolved` | Linked across files by static module resolution and export-name matching, through `export {x} from` and `export * from` chains. | `requireAuth` → `verifyToken` via `@lib/index.ts`. |
| `heuristic` | Naming convention only. | `test/token.test.ts` ↔ `src/token.ts` when the test does not import it. |

Cross-file edges are stored as (import, exported name) and resolved at query time, so editing a target file never leaves a stale edge behind. Unlinkable things are reported in an `uncertain` section; they are never guessed.

## Context compiler (`maxify_context`)

1. **Analyze** the task: identifiers and paths are matched exactly; prose words by light stemming and prefix; English and Spanish stopwords are dropped.
2. **Search** FTS5 for candidates and score them with field-weighted BM25-style scoring computed in Maxify (robust on small repositories), plus exact-identifier and path bonuses and intent weights (tests, docs, config). Symbols matched only through their file path keep 30 % of their score. Code files that no test or entry point reaches through resolved imports (often dead or legacy code) keep 50 % and are flagged `UNREACHED` in the output; they are never hidden.
3. **Expand** the strongest candidates one hop: callees and contract types (what the code depends on), callers, tests, enclosing class; a second hop adds contract types of the strongest callees.
4. **Deduplicate**: one item per symbol; items contained in another item shown as source are not repeated.
5. **Plan detail levels** greedily by priority: exact source for primaries, then contracts, then tests/callers as locations, then upgrades with what remains, only for items above 20 % of the top priority. The budget (default 6000) is a ceiling, not a target. An item is rendered whole at a level or omitted, never cut.
6. **Verify and render**: every file shown is re-read and its hash compared with the index (re-index and retry on mismatch); the rendered text is re-measured and demoted until it fits the budget and the 45,000-character cap.

Output levels: `[src]` exact current source, `[sig]` derived signature (labelled as not source), `[map]` location only. Every result states the generation, the content hash of each file, uncertainties, omitted refs with their source cost, and a cursor when more evidence is available.

## Freshness

- Before every query: incremental refresh (debounced to 1 s).
- At render time: every file shown is hashed again; any mismatch triggers a re-index and a recompile.
- `maxify_source` reads from disk and re-indexes when the file changed after the symbol spans were computed.

## Compression

`compress()` is pure. It classifies the input (log, test, search, json, list, diff, text), applies one of three transformation classes, and never drops a critical line (errors, failures, assertion diffs, summaries, focus terms). The engine stores the exact original (gzip at rest, never shown to the model) under its SHA-256 and returns `blob:HASH`; `maxify_compress {ref, lines}` returns any original range exactly until the blob expires (default 7 days, LRU-capped at 200 MB). If compression does not reduce the size enough, the original is returned.

## Caching and memory

- Context results are cached by (task, options, generation, config hash, version). The cache saves CPU and latency, not tokens.
- Delta responses (replace already-sent source by a reference) exist but are off by default: the client may have compacted earlier results.
- Notes are explicit, small (≤ 1000 chars), carry origin (agent/user), kind and refs anchored to file hashes; they are shown as "agent/user-authored, not verified source" with a `current` or `STALE` status.

## Security model

- Everything is local; no telemetry. Metrics stay in the state database.
- All paths pass through `RepoGuard` (no `..` escapes, no symlink escapes, no NUL bytes; on Windows also no alternate data streams, 8.3 short names, trailing dots/spaces or device names). Every on-request read goes through one reader that classifies both the requested path and its real path (so an in-repo link to `.env` is refused), requires a regular file under 20 MB, and refuses binary content and PEM private keys. Secret and ignored files are refused by `maxify_source` and `maxify_compress`; ignored logs can still be compressed by piping them into the CLI.
- Retrieved code, docs and logs are data: they are fenced with collision-proof fences and the server instructions say so. Maxify executes no shell commands.
- Refusing unsafe roots (filesystem root, home directory) prevents indexing a whole disk by mistake.
