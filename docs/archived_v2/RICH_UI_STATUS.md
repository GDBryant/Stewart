# Rich UI rewrite — archived status

**TASK COMPLETE.** Shipped in `687bf14`; function-limit refactor in `02d2599`. No protocol or core changes. All 6 suites passed (160 tests), typecheck was clean, and coverage was above the 90/80 gate. Current behavior is summarized in `docs/ai_docs/ARCHITECTURE_NOW.md` §2.

## What shipped (per file)

| File | Change |
| --- | --- |
| `src/markdown.tsx` (new) | Hand-rolled Markdown subset for assistant replies → Preact VNodes: fenced code, h1–h6, pipe tables, ul/ol, paragraphs (hard breaks), inline `code`/bold/italic/links. Text between spans is emitted as safe text nodes; unsafe link schemes are dropped; unknown lines fall back to paragraphs. |
| `src/MessageItem.tsx` | Role labels ("user" / "Stewart (agent)"); new `StepsBlock` — collapsible step list, open while streaming, auto-collapses on finish, manual toggle is sticky (plain button, no `<details>`); `activityIcon()` maps tool names → glyphs (📖 read, 🔍 search, ✎ write, ⌨ terminal, ✅ ok, ❌ fail, ⤴ escalated, ⚙ fallback); assistant bubble renders via `renderMarkdown`; new "Files changed" footer from `ChatItem.filesChanged`. |
| `src/state.ts` | `ActivityEntry` gains `tool?`/`category?`; `addActivity()` returns the new step's index; new `updateActivityAt(runId, index, patch)` patches a step in place. |
| `src/stateHandlers.ts` | `tool.request` adds a step and records it in `pendingTools` (callId → tool/category/index); `tool.outcome` patches that same step to `tool-ok`/`tool-fail` with the outcome summary — one step per tool call instead of two rows. `run.finished` sets `filesChanged` from `outcome.changed` and clears `pendingTools`. |
| `src/stateTypes.ts` | `ActivityEntry` interface; `ChatItem.filesChanged?: string[]`. |
| `src/ChatView.tsx` | Auto-scroll also triggers on last item's step count, not just text. |
| `src/styles.css` | ~34 new rules: role labels, steps head/caret/list, act icons, `.bubble-md` markdown styles (headings, lists, code, tables, links), files-changed footer. |
| `test/markdown.test.tsx` (new, 10 tests) | Each markdown feature + HTML-escape injection check + empty input + safe-URL guard; `afterEach(cleanup)`. |
| `test/app.test.tsx` (+8 tests) | Role labels; steps expand-while-streaming / auto-collapse; sticky manual toggle; tool.request↔tool.outcome pairing into one step; Files changed footer + "No files changed" system row; icon mapping; reasoning toggle. |
| `.gitignore` | `.stewart/scratch/` → `.stewart/` (whole dir ignored). |

Protocol alignment: no changes needed — `tool.request` carries `callId/tool/category`,
`tool.outcome` carries `callId/ok/summary`, and `run.finished.outcome.changed` carries the file list.
"No files changed" renders as a system row via `outcomeText()` (`stateHandlers.ts`), so that test expectation holds.

## Step 1 — rename applied (markdown.ts → markdown.tsx)

`src/markdown.ts` contained JSX with a `.ts` extension — neither esbuild (vite/vitest
transform) nor tsc parses JSX in `.ts` files. Fixed with a plain `mv` (file was untracked);
the `./markdown.js` import specifier resolves to `.tsx` under both, so no other file
changes. Transform + tsc then worked; 4/6 suites loaded, 153 passed, 6 failed.

## Step 2 — the rename surfaced 8 latent bugs; all fixed

| # | Bug | Fix | Where |
| --- | --- | --- | --- |
| 1 | `inline()` checked tokens in fixed priority — a backtick before `**bold**` made the bold branch unreachable, so pre-code text emitted raw | Dispatch now picks the *earliest* of backtick / `**` / single-`*` / link; single-`*` detection is pair-aware (replaces the fragile `rest[ib-1] !== "`"` guard) | `markdown.tsx` |
| 2 | `esc()` HTML-escaped strings Preact already renders as safe text nodes → double-escaping (`&lt;` visible literally) | Removed `esc()`; text between spans is emitted as plain strings (safe by construction) | `markdown.tsx` |
| 3 | Table separator regex `^ *:?-{3,}:? *$` couldn't match piped separator rows (`| --- | --- |`) → tables rendered as paragraphs | New `isSepRow()`: every piped cell must match `^:?-+:?$` | `markdown.tsx` |
| 4 | Assistant streaming placeholder lost: `renderMarkdown("")` renders nothing, so an empty streaming turn showed no `…` | `item.text ? renderMarkdown(…) : streaming ? "…" : null` | `MessageItem.tsx` |
| 5 | `run.started` never created the assistant item, so a run with no deltas had no item for `filesChanged` to attach to → "Files changed" footer never appeared | `run.started` now opens the assistant turn immediately (`mutateAssistant(…, streaming: true)`) | `stateHandlers.ts` |
| 6 | `onCheckResult` did `return this.addActivity(…)` — `number` leaked from a `void` method (tsc TS2322) | Plain statement + return | `stateHandlers.ts` |
| 7 | `ActivityEntry.text` required, but `addActivity` accepted text-less entries and tests call `activityIcon({kind, tool})` without it | `text?` optional; `MessageItem` uses `a.text ?? ""` | `stateTypes.ts`, `MessageItem.tsx` |
| 8 | Role-label test wrapped `fireEvent.input` + `fireEvent.click` in one `act()` — Preact doesn't flush the draft re-render between them, so the click sent the stale `""` draft and the user item was never created (verified: scratch test shows separate scopes work, single scope doesn't; direct `store.send` always worked) | Test artifact — removed the outer `act` | `app.test.tsx` |

Also: `markdown.test.tsx` was missing `afterEach(cleanup)` — the table test's DOM leaked
into the next test; added, plus a new positive/negative test for the `safeUrl()` guard
(`javascript:`/`data:`/`vbscript:` hrefs dropped from markdown links).

## Final verified state (Node v22.23.2 in PATH, from `packages/webview`)

```
./node_modules/.bin/vitest run            # 6/6 suites, 160/160 tests pass
./node_modules/.bin/tsc -p tsconfig.json --composite false --noEmit   # clean
./node_modules/.bin/vitest run --coverage # All files 94.23% line / 88.92% branch (gates: ≥90/≥80)
   per-file: MessageItem 100/91.5, markdown 98.8/90.1, state 95.8/88.4, stateHandlers 90.6/88.4
```

## Environment gotcha

Default `node` on PATH is v18.19.1, under which jsdom crashes before any test runs
(`webidl-conversions` / `whatwg-url` load error, "Tests: no tests"). Use
`~/.nvm/versions/node/v22.23.2/bin` first on PATH.

## Follow-ups

1. Manual pass in both hosts (VS Code + JCEF) on the new rendering: markdown, steps
   expand/collapse, icons, files-changed footer, auto-scroll during streaming.
2. The `.gitignore` `.stewart/` broadening shipped with `687bf14`.
3. `docs/ai_docs/ARCHITECTURE_NOW.md` now carries the durable highlights; this file is implementation history only.
