# Research notes: platform facts and opportunity

Checked on **2026-10-26** against official sources. Each item is marked as a **fact**
(verified in the source or locally) or a **hypothesis** (what Maxify bets on and must measure).

## Versions and licenses

| Project | Version / commit | License | Local install on the dev machine |
|---|---|---|---|
| MCP specification | protocol `2026-07-28` | — | — |
| MCP TypeScript SDK | `@modelcontextprotocol/sdk` 1.32.2 (v1 line, `latest`); split v2 packages `@modelcontextprotocol/server` 2.4.0 (GA 2026-07-27) | MIT | — |
| Claude Code | 2.1.87 | — | installed |

## Claude Code MCP behavior (facts, code.claude.com/docs/en/mcp)

- Tool search is on by default: only tool names and server instructions load upfront; schemas load on demand unless the server sets `alwaysLoad` (or a tool sets `_meta["anthropic/alwaysLoad"]`).
- Results above 10,000 tokens warn; above `MAX_MCP_OUTPUT_TOKENS` (default 25,000) or 50,000 characters they are saved to a file and replaced by its path.
- Server instructions are truncated at 4,096 characters. `CLAUDE_PROJECT_DIR` is set in the server environment. Startup timeout 30 s.
- Whether `structuredContent` reaches the model is not documented.

## Gaps and Maxify's hypotheses

| Gap in common context tooling | Maxify hypothesis (to be measured) |
|---|---|
| No task-level, budgeted context: code-graph and search tools answer one query (node, neighbors, file) at a time, so agents chain calls. | **H1** One `maxify_context` call that returns ranked map + exact source of the key symbols + contracts + tests + uncertainties reduces tool-call chains and total tokens per solved task. |
| Freshness is checked per graph build, or not at all when stored snapshots are served back. | **H2** Per-evidence hash verification at answer time prevents stale-evidence edits after files change. |
| Lossy structural views (signatures only, bodies dropped) can hide the condition that matters. | **H3** Shipping exact source for the few symbols that matter, and derived views only for the rest, keeps correctness while still cutting volume. |
| Output compression usually runs through a proxy with lossy compressors. | **H4** Evidence-preserving compression (every error/failure line verbatim, explicit format/selection/summary classes, exact original by hash) used as a CLI pipe keeps raw logs out of the context without hiding failures. |
| — | **H5** On tiny tasks Maxify's overhead (instructions, schemas, an extra call) can exceed its savings. Reported, not hidden. |

## Technical decisions

- **SQLite via `node:sqlite`** (bundled with Node >= 22.13, FTS5 compiled in, verified: SQLite 3.51.2): no native build step on Windows/macOS/Linux. Trade-off: the module still prints an ExperimentalWarning, which the CLI filters.
- **TypeScript 6.0.3** for the Compiler API: TypeScript 7.0 (native port) no longer exposes the classic `ts.createSourceFile` / `ts.resolveModuleName` JavaScript API (only `unstable/*` entry points).
- **MCP SDK v1 (1.32.2)**: still the `latest` tag of `@modelcontextprotocol/sdk`, maintained, and compatible with current Claude Code. Migrating to the split v2 packages is listed as future work.
- **No `structuredContent`**: results are a single text block so the model never receives the same evidence twice.
- **`alwaysLoad` only for `maxify_context` and `maxify_source`**: once a deferred tool is loaded its schema stays in the conversation anyway, so deferring the two tools that are used in every task only adds a tool-search round trip; the other four stay deferred.
