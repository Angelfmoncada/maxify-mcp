# Research notes: prior art and opportunity

Checked on **2026-10-26** against official sources. Each item is marked as a **fact**
(verified in the source or locally), a **vendor claim** (reported by the project, not
reproduced by us), or a **hypothesis** (what Maxify bets on and must measure).

## Versions and licenses

| Project | Version / commit | License | Local install on the dev machine |
|---|---|---|---|
| Caveman (`JuliusBrussee/caveman`) | release `v4.0.1` (2026-10-13, tag `d262ab38`); `main` HEAD `9b68f7ed` (2026-10-25) | Apache-2.0 (pre-3.0 code MIT) | Claude Code plugin `caveman@caveman` 4.0.1, built from `main` commit `bad48a0e` |
| Graphify (`Graphify-Labs/graphify`) | release `v0.9.95` = `v8` HEAD `92741d16` (2026-10-23); PyPI `graphifyy` 0.9.95 | Apache-2.0 (older parts MIT) | `graphify` 0.9.92 (pipx) |
| MCP specification | protocol `2026-07-28` | — | — |
| MCP TypeScript SDK | `@modelcontextprotocol/sdk` 1.32.2 (v1 line, `latest`); split v2 packages `@modelcontextprotocol/server` 2.4.0 (GA 2026-07-27) | MIT | — |
| Claude Code | 2.1.87 | — | installed |

## What already exists (facts)

**Caveman**
- Output: a "voice" skill that makes the model answer tersely; its rules cost about 1,160 input tokens per session.
- Memory files: `/caveman-compress` rewrites files such as `CLAUDE.md` (sent to the configured model provider), keeping a backup.
- Tool output: a local loopback proxy (agent base-URL swap) detects the input shape and applies one of 16 lossy compressors (code compressor keeps imports/signatures, drops bodies). Failures pass the original through.
- Recovery: exact originals are kept in SQLite (`~/.caveman/ccr.db`, `ccr_` handles, 512 MiB cap, no eviction).
- Also: `caveman shrink -- <cmd>`, a `caveman-mcp` stdio server (Compress/Retrieve/Stats), model routing, subagents.
- The installed plugin registers hooks only (SessionStart, SubagentStart, UserPromptSubmit, SessionEnd); no MCP server.

**Graphify**
- Code graph from tree-sitter ASTs, locally and without an LLM; docs/PDF/images need a model or API key (`--code-only` disables that).
- Edge labels `EXTRACTED` / `INFERRED` (with confidence scores) / `AMBIGUOUS`.
- Local stdio MCP server with 10 plain-text tools (`query_graph` with `token_budget` default 2000, `get_node`, `get_neighbors`, `shortest_path`, `graph_stats`, …), no server instructions.
- Incremental updates via SHA-256 cache and manifest; `graph_stats` compares the build commit with HEAD ("graph may be stale").

**Claude Code MCP behavior** (code.claude.com/docs/en/mcp)
- Tool search is on by default: only tool names and server instructions load upfront; schemas load on demand unless the server sets `alwaysLoad` (or a tool sets `_meta["anthropic/alwaysLoad"]`).
- Results above 10,000 tokens warn; above `MAX_MCP_OUTPUT_TOKENS` (default 25,000) or 50,000 characters they are saved to a file and replaced by its path.
- Server instructions are truncated at 4,096 characters. `CLAUDE_PROJECT_DIR` is set in the server environment. Startup timeout 30 s.
- Whether `structuredContent` reaches the model is not documented.

## Vendor claims (not reproduced here)

- Caveman: 33.2 % fewer provider-reported input tokens on 6 MCP-heavy fixtures (18/18 exact answers, 54 runs, Claude Code 2.1.223, Sonnet); voice-only savings 3 % (`/caveman`) to 35 % (`/ultracave`) of output tokens on a 10-prompt benchmark; the "65 %" tagline refers to readable output, about 10 % of total tokens on long tasks.
- Graphify: 71.5x fewer tokens per query on a 52-file corpus, 5.4x on 4 files, about 1x on 6 files.

## Gaps and Maxify's hypotheses

| Gap observed in the sources | Maxify hypothesis (to be measured) |
|---|---|
| No task-level, budgeted context: tools answer one query (node, neighbors, file) at a time, so agents chain calls. | **H1** One `maxify_context` call that returns ranked map + exact source of the key symbols + contracts + tests + uncertainties reduces tool-call chains and total tokens per solved task. |
| Freshness is graph-level (Graphify) or not checked (Caveman CCR handles are snapshots). | **H2** Per-evidence hash verification at answer time prevents stale-evidence edits after files change. |
| Lossy structural views (signatures only, bodies dropped) can hide the condition that matters. | **H3** Shipping exact source for the few symbols that matter, and derived views only for the rest, keeps correctness while still cutting volume. |
| Output compression exists (Caveman) but through a proxy and lossy compressors. | **H4** Evidence-preserving compression (every error/failure line verbatim, explicit format/selection/summary classes, exact original by hash) used as a CLI pipe keeps raw logs out of the context without hiding failures. |
| — | **H5** On tiny tasks Maxify's overhead (instructions, schemas, an extra call) can exceed its savings. Reported, not hidden. |

## Technical decisions

- **SQLite via `node:sqlite`** (bundled with Node >= 22.13, FTS5 compiled in, verified: SQLite 3.51.2): no native build step on Windows/macOS/Linux. Trade-off: the module still prints an ExperimentalWarning, which the CLI filters.
- **TypeScript 6.0.3** for the Compiler API: TypeScript 7.0 (native port) no longer exposes the classic `ts.createSourceFile` / `ts.resolveModuleName` JavaScript API (only `unstable/*` entry points).
- **MCP SDK v1 (1.32.2)**: still the `latest` tag of `@modelcontextprotocol/sdk`, maintained, and compatible with current Claude Code. Migrating to the split v2 packages is listed as future work.
- **No `structuredContent`**: results are a single text block so the model never receives the same evidence twice.
- **`alwaysLoad` only for `maxify_context` and `maxify_source`**: once a deferred tool is loaded its schema stays in the conversation anyway, so deferring the two tools that are used in every task only adds a tool-search round trip; the other four stay deferred.
