# Benchmarks

Status on **2026-10-27**, Maxify 0.1.0, Node 22.22.1, Windows 11.

| Suite | Status | What it measures |
|---|---|---|
| Offline (evidence recall) | **Run.** Results below; full report in [benchmarks/offline-2026-10-27.md](benchmarks/offline-2026-10-27.md). | Whether the evidence a task needs reaches the model, and at what estimated token cost, versus two simulated native search strategies. |
| Agent (Claude Code end to end) | **Pending.** Harness built and dry-run verified; no paid run executed. | Tasks solved (hidden tests), provider-reported tokens and cost, tool calls, per condition. |

No result in this document is an agent result. Do not read the offline numbers as "Maxify saves X % of a Claude Code session".

## Three different savings

1. **Result size**: tokens of a Maxify result versus the raw text it replaces. Measured locally (estimates).
2. **Session tokens**: everything the model reads and writes during a task, including instructions, tool schemas, extra turns and retries. Only the agent suite can measure it, from provider-reported usage.
3. **Billed cost**: session tokens priced by type (cache reads are much cheaper than fresh input). Only the agent suite reports it (`total_cost_usd`).

A smaller result that causes extra calls can cost more in (2) and (3). That is why the offline suite counts follow-up calls and the agent suite is the only one allowed to claim session savings.

## Offline suite

**Setup.** Fixture `bench/fixtures/taskboard`: a React + Node + TypeScript task board (60 text files, 3,691 lines) with a path alias, a barrel re-export, a dynamic plugin import, a CommonJS module, and decoys (an unused `src/legacy/` auth implementation, `tokenize.ts` unrelated to auth tokens). 18 tasks in 8 categories (diagnosis, multi-module change, contract update, test search, post-edit query, small task, uncertainty, decoy precision), each with ground-truth evidence at a required level (`map`, `signature`, `source`) and forbidden decoys. Ground truth was written against the fixture, and symbol ranges are checked by an independent TypeScript-API oracle.

**Strategies compared** (same token estimator for everyone, 12 tokens of client wrapper per call):

- **Maxify**: one `maxify_context({task, budget})` call; then a "diligent follow-up" simulation that fetches each still-missing requirement once (`maxify_source` or a focused map call). The simulation knows which refs are missing, which is optimistic for Maxify.
- **Native A**: keyword grep, then read the top 3 files fully (with `cat -n` numbers).
- **Native B**: keyword grep, then read the best 8 windows of ±25 lines.
Both native strategies are deterministic simulations that rank with information plain grep does not print; they bound what a naive keyword workflow costs and finds. They are not models of a real agent.

**Results** (means over 18 tasks; tokens are local estimates):

| Budget | Maxify 1st call | Maxify + follow-ups | Native A | Native B | Recall 1st call | Recall after follow-ups | Recall A | Recall B |
|---|---|---|---|---|---|---|---|---|
| 2000 | 1,931 | 2,642 | 5,857 | 15,134 | 50 % | 98 % | 30 % | 68 % |
| 4000 | 3,815 | 4,307 | 5,857 | 15,134 | 65 % | 99 % | 30 % | 68 % |
| **6000 (default)** | **5,031** | **5,445** | 5,857 | 15,134 | **70 %** | **100 %** | 30 % | 68 % |
| 8000 | 5,449 | 5,820 | 5,857 | 15,134 | 73 % | 100 % | 30 % | 68 % |

**Reading it honestly**

- **Regressions flagged by the suite**: at budgets 2000 and 4000 the *first call* reaches less evidence than Native B (50 % and 65 % vs 68 %) while using fewer tokens. By the project rule, fewer tokens with lower recall is a regression, so these budgets are not recommended for a single-call workflow. This is why the default budget is 6000.
- At the default budget the first call reaches more evidence than Native B (70 % vs 68 %) with about a third of its tokens; after follow-ups recall is 100 % at 5,445 tokens on average.
- Native A is cheaper than Maxify on several tasks at budgets ≥ 6000 (19 task/budget pairs are listed in the full report), but it reaches only 30 % of the evidence.
- Decoys still appear: at 6000, 8 of 18 tasks include a decoy somewhere in the result (4 as signature or source; the rest as map lines). Unreachable code is now flagged in the output (`UNREACHED: no test or entry point imports it`), but ranking remains lexical.
- Tuning was done on this same fixture (fill threshold, default budget, ranking weights). Numbers on unseen repositories will be lower; an out-of-sample suite is future work.

**Performance**: cold index of the fixture 290 ms (60 files), incremental re-index after a one-file edit 20 ms; first-call latency median ≈ 55 ms. Indexing the Maxify repository itself: 367 files in 1.6 s cold, 72 ms incremental with no changes.

**Reproduce**: `npm ci && npm run build && node dist/cli.js bench --out bench/results/offline.md` (also writes `.json`). Exit code 1 means the suite flagged at least one regression, as above.

## Agent suite (pending)

`bench/agent/` runs Claude Code headless (`claude -p … --output-format stream-json`) on fresh copies of the fixture with hidden tests. Each task was verified both ways: the hidden test fails after the setup patch and passes with the reference solution.

- **Conditions**: `native` (Claude Code with its built-in tools only) and `maxify` (the same plus the Maxify MCP server).
- **Tasks**: add-task-labels, assign-task, default-page-size (tiny, overhead case), diagnose-token-expiry, explain-plugin-loading, fix-failing-status-rules, rename-and-reopen.
- **Isolation**: `--setting-sources project`, `--strict-mcp-config`, config written only inside each temporary copy; user-level settings and global config are untouched.
- **Metrics**: hidden-test pass rate, provider-reported input/output/cache tokens, `total_cost_usd`, turns, tool calls by name, tokens per solved task; cold vs warm cache recorded separately; a condition with fewer tokens but fewer solved tasks than native is flagged **REGRESSION**.
- **Safety**: dry-run by default; `--confirm-spend` is required, with a per-run cap (`--max-budget-usd`, default $2) and a total stop-loss ($25).

The default plan is 14 runs (7 tasks × the 2 conditions × 1 repetition). It has not been executed because it spends the user's Claude usage. Recommended next step: a pilot with one tiny task and the `native` and `maxify` conditions, then extrapolate cost from `total_cost_usd`.

```bash
node bench/agent/run.mjs                      # dry run: plan and run count
node bench/agent/run.mjs --tasks default-page-size --conditions native,maxify --reps 1 --confirm-spend
node bench/agent/report.mjs                   # aggregate JSONL results
```
