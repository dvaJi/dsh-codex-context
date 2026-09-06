# dsh-codex-context

An experimental, **lossless-retrieval context manager** for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh), inspired by the experimental `context_management` architecture introduced in Codex 0.153 (`codex-rs/core/src/context_manager/`).

It replaces dsh's default LLM-summarizing compaction backend with a **token-budgeted sliding window** over dsh's append-only session log, pins **persistent working notes** in front of the model, and exposes **cold-history search** so nothing that leaves the active window is ever truly gone.

Reference implementation for the Pi coding agent: [`Xeron2000/pi-codex-context`](https://github.com/Xeron2000/pi-codex-context).

---

## Why

Long agent sessions suffer from window exhaustion, attention dilution, and lossy summary compaction that permanently destroys exact error strings, command outputs, and code signatures. dsh's session model makes a better trade possible:

- The session log is **append-only and lossless** — compaction only *shadows* surface nodes via `surfaceOp: { op: 'replace' }`; the raw events stay in the log forever.
- `ctx.compaction` is a capability seam explicitly designed for third-party backends ("a fixed template backend is a sibling package implementing the same interface").
- `ctx.tokenMeter` gives one replay-aware measurement service; `ctx.systemPrompt.context()` pins dynamic, durable model-visible context.

This plugin composes those into the 3-tier architecture:

```
┌────────────────────────────────────────────────────────┐
│                   Active Context Window                │
│   • System prompt & tools                              │
│   • [Context Notes] (pinned dynamic snapshot)          │
│   • Recent working set (≤ targetActiveTokens,          │
│     cut only on safe boundaries)                       │
└──────────────────────────┬─────────────────────────────┘
                           │  match-centered retrieval
                           ▼  (search_history)
┌────────────────────────────────────────────────────────┐
│               Canonical Cold Storage                   │
│   • The append-only session log itself                 │
│   • Shadowed nodes: full outputs, stack traces,        │
│     tool calls — never summarized away, never deleted  │
└────────────────────────────────────────────────────────┘
```

### What the engine does

- **Token-aware sliding window** — when the priced surface exceeds the effective budget (config `targetActiveTokens`, capped at `emergencyThresholdRatio` of a routed context window too small to ever reach the configured target), the engine walks backwards accumulating node prices and shadows the oldest balanced span until the retained tail fits the budget, snapping the cut to a whole-turn boundary whenever the budget allows it.
- **Zero-orphan boundaries** — both cut edges are validated with the compaction seam's `toolPairingBalancedBefore/After`, so a tool call is never separated from its result (Codex's `normalize` invariants), and the minimum recent tail is always retained verbatim.
- **Model-free checkpoints** — routine windowing writes a tiny template checkpoint (`[Window Checkpoint]` + retrieval guidance) instead of paying an LLM call. The raw span stays queryable.
- **Emergency parachute (Codex behavior)** — Codex windows routinely but *summarizes* near the limit (auto-compact with `SUMMARIZATION_PROMPT`). Likewise, when routine step pressure crosses `emergencyThresholdRatio` (default 0.85) of the routed model's context window, the engine writes a real structured model summary through `ctx.llm.stream()` — reusing the conversation's system prompt, tools, and shadowed messages as a warm prefix — instead of the template. The parachute is best-effort: a failed or truncated summary degrades to the template checkpoint, and provider-confirmed overflows (`CONTEXT_WINDOW_EXCEEDED`) skip it entirely — a further near-limit model call would most likely fail and block the only reduction that can succeed.
- **Durable transaction** — every windowing operation follows the compaction seam contract: the `compaction/start` … `compaction/end` log-recorded lock, whole-surface or selected-span stability revalidation, shrink validation against the token meter, and exactly one close attempt per failure. Overflow recovery (`CONTEXT_WINDOW_EXCEEDED`) retries after a durable replacement advances the surface generation.

### What the model gets

| Tool | Purpose |
|---|---|
| `update_notes` | Update the persistent working notes (goals, modified files, constraints, next steps). Pinned at the top of every subsequent request; survives windowing, compaction, and restarts. |
| `search_history` | Regex/keyword search over the **full** session log — user prompts, assistant messages (including reasoning), tool calls, and complete tool outputs. Cold (shadowed) history is searched first; excerpts are centered on the match position, not sliced from offset 0. Queries are case-insensitive keywords or regexes of at most 512 characters; empty or whitespace-only queries are rejected, and patterns with nested unbounded quantifiers (a catastrophic-backtracking hazard, e.g. `(a+)+`) are refused with guidance. |

Notes persistence needs **no custom session event type**: the agent loop already logs dynamic runtime contexts as durable `user/message` snapshots (`source: @deepseek-ai/dsh-system-prompt`, `form: 'snapshot'`) whenever the rendered text changes, and re-logs the snapshot after compaction removes it. Restoring notes is a backward fold over the log for the latest `codex-context:notes` section.

---

## Install

The package is a dsh **bundle** (its `package.json` declares `dsh.bundle` with `cordis.patch.yml`). The patch overrides the base `compaction-basic` row by id, so mounting it swaps the summarizing backend for this engine in one line. `command-compact` (`/compact`) and the optional tool-result pruner keep working unchanged.

From a dsh source checkout (recommended while the `@deepseek-ai/*` npm mirrors hold stale RCs):

```sh
dsh plugin --profile demo add /path/to/dsh-codex-context
dsh --profile demo --dump-config   # shows the replaced compaction row
dsh --profile demo
```

From GitHub, pin a commit and allow the build (pnpm ≥10 refuses a git dependency's `prepare` script until allowlisted):

```sh
dsh plugin --profile demo add github:dvaJi/dsh-codex-context#<sha>
# add to the profile's pnpm-workspace.yaml:
#   allowBuilds:
#     dsh-codex-context: true
```

Or ship a tarball: `pnpm pack` → `dsh plugin --profile demo add ./dsh-codex-context-0.1.1.tgz`.

### Keep summarizing compaction, add only the retrieval layer

A tools-only entry is exported for compositions that want notes + search alongside the shipped backend:

```yaml
- insert:
    - id: codex-context-tools
      name: dsh-codex-context/tools
```

Never mount both entries in the same context — the tool names would collide.

---

## Configuration

Everything is a config field; all values are optional (schema defaults shown). Add a `config:` block to the bundle row in your profile's `cordis.patch.yml` — a patch replaces the row's whole `config`, so restate every key you care about.

| Field | Default | Meaning |
|---|---|---|
| `auto` | `true` | Automatic windowing (`agent/pre-step` pressure) and overflow recovery (`agent/request-error`). |
| `targetActiveTokens` | `35000` | Token budget for the active window; the backwards walk shadows older nodes until the tail fits. When the routed model's context window is smaller than `targetActiveTokens / emergencyThresholdRatio`, the effective budget is capped at `emergencyThresholdRatio × contextWindow` so windowing runs pre-emptively instead of waiting for an overflow. |
| `minRetainedNodes` | `6` | Recent surface nodes always retained verbatim. |
| `maxExcerptLength` | `1000` | Character budget per match-centered search excerpt. |
| `searchDefaultLimit` | `3` | `search_history` result cap when the model omits `limit`. |
| `searchMaxScanEvents` | `20000` | Safety cap on log events scanned per search call. |
| `emergencyThresholdRatio` | `0.85` | Pressure fraction of the context window above which the engine writes a real model summary (the parachute). |
| `emergencySummarization` | `true` | Master switch for the parachute; `false` keeps windowing model-free at all times. |
| `summarizationProvider` / `summarizationModel` | `''` | Fixed route for the emergency summarizer; empty uses the routed request target, then `AgentOptions`. Configure both as a pair (both empty or both set) or the plugin refuses to load. |
| `emergencyMaxTokens` | `8192` | Output cap for the emergency summarization request. |
| `maxOverflowRetries` | `1` | Extra windowing attempts after a provider-confirmed context overflow. |
| `notesHint` | hint text | Line appended under the pinned notes snapshot; empty disables it. |
| `retrievalHint` | hint text | Guidance sentence embedded in every window checkpoint. |

Invalid values (ratios outside `(0, 1]`, non-positive budgets) fail the plugin at load.

---

## Architecture notes

- **Where it hooks**: `ctx.compaction` (Service Definition in `@deepseek-ai/dsh-compaction`), `ctx.tokenMeter.measure()` for all pricing, `agent/pre-step` (waterfall — pressure), `agent/request-error` (overflow), `ctx.systemPrompt.context()` (pinned notes), `ctx.tools.register(defineTool(...))` for both tools.
- **Prefix-cache impact**: unlike a summary replacement of arbitrary text, the template checkpoint is tiny and stable; the retained tail is untouched, so reuse survives from the window boundary forward. The emergency summarizer replays the conversation's own prefix byte-for-byte before its instruction, so only the instruction and output are uncached.
- **Log-only records**: `compaction/start`, `compaction/summary`, `compaction/end` (and the replacement `user/message` with its shadowed `sourceEventSeqs`) are written exactly as the seam's persistence catalog documents, so session-query tools, replay, and the web UI all recognize them.

### Deviations from the reference port

- Pi rewrites messages in memory per turn (`context` event); dsh's window replacement is **durable** — the checkpoint is part of the session, which is what makes `/compact`, replay, and cold reads consistent.
- Pi restores notes from branch entries (`pi.appendEntry`); dsh has no branches — the durable runtime-context snapshot plays that role.
- dsh ships its own model-facing history tools (`session_search`, `session_event_search`, …). They are complementary: `search_history` is cold-first and match-centered within the *current* session and stops before the invoking call, while the session-query tools are workspace-wide.

## Known limitations

- **Indivisible units** — one surface node larger than the window cannot be repaired by surface compaction (same contract limit as the shipped backend). The emergency summarizer can still prevent a hard overflow when the route reports capacity.
- **Template checkpoints are not summaries** — routine windowing deliberately spends no model call; the model is expected to retrieve cold facts with `search_history` instead of relying on a lossy digest. That is the point of lossless retrieval — but it only works if the model actually calls the tool.
- **Heuristic metering** — the token meter's four-characters-per-token heuristic underprices CJK text and JSON schemas; window boundaries are approximate by design.
- **`compactRegion` requires an open turn** (contract limitation inherited from the seam's transaction shape for automatic calls).

## Development

```sh
pnpm install
pnpm test        # vitest over the pure core (window planning, excerpts, extraction)
pnpm build       # tsc → lib/ + lib/types/
pnpm typecheck
```

The pure modules (`src/window.ts`, `src/template.ts`, `src/extract.ts`) have zero harness imports and are unit-tested standalone. The harness-coupled modules typecheck against `types/vendor.d.ts` — a **dev fallback shim** mirroring the verified dsh signatures, present because the npm mirrors hold stale RCs. When developing against a real dsh checkout, remove `types/**/*.d.ts` from `tsconfig.json` `include` to typecheck against the authoritative packages instead.

## License

MIT — see [LICENSE](LICENSE).
