# Chat segments plan (2026-11-19)

## Problem
One run = one assistant `ChatItem` (`id === runId`, `Store.assistantFor`). Every `text_delta` is appended to it, so:
- narration across model turns runs together with no break (`…in deprecated/.The workspace…`);
- `ask_user` questions and their answers leave no mark in the transcript; text after the answer continues the same bubble;
- the run's final output is the tail of the progress bubble.

## Design (webview only, no protocol change)
1. **Segments.** `ChatItem` gains `runId?: string`. A run renders as several assistant items: first id `runId`, later ones `${runId}:${n}`. `assistantFor(runId)` reuses the last item only if it is an assistant item with `runId === runId` and `streaming`; otherwise it opens a new segment. Anything appended after a segment therefore starts a new one.
2. **Questions break the segment.** On `ask_user` the current run segment is closed (`streaming: false`, steps collapse). On `Store.answer` a Q&A item is appended: `{ id: "qa<n>", role: "system", qa: { question, answer }, activity: [] }`, rendered by `MessageItem` as a compact card (question via `renderMarkdown`, answer below). The next delta/step opens a new segment. `question.withdrawn` adds no Q&A item.
3. **Paragraph break between model turns.** Segment tracks `stepsAtText` (activity count at the last text append). On `text_delta`, if the segment has text and steps were added since, prepend `"\n\n"` and set `tailStart = text.length` (start of text written after the last step).
4. **Final output block.** On `run.finished`, for the run's last segment: if `0 < tailStart < text.length`, split the tail into its own assistant item `${runId}:final` (no steps). `filesChanged`/`filesBaseline` attach to the run's last item (the final block when split). All run segments get `streaming: false`.
5. **Tool pairing across segments.** `pendingTools` stores the item id; `HandlerHost.addActivity` returns `{ itemId, index }`, `updateActivityAt(itemId, index, patch)` patches by item id, so a `tool.outcome` that arrives after a split updates the right segment.
6. **runFinished.ts.** `markRunItem`/`applyFailure` match on `runId` (fallback `id`), not `id === runId`.

New logic goes in `packages/webview/src/segments.ts` (pure helpers); `stateHandlers.ts` is at 302 lines and must not grow. Function limits apply (≤40 lines, complexity ≤10, depth ≤3, ≤4 params).

## Tests (`packages/webview/test/segments.test.ts`, Store + `MockBridge`)
- text → `ask_user` → answer → text: items = segment, Q&A, segment; first segment `streaming: false`; Q&A holds question + answer.
- `question.withdrawn`: no Q&A item.
- text, tool step, text: one bubble, `"\n\n"` between parts; text with no step between: no separator.
- finish with narration + step + tail: tail split into `:final`, files on it; finish with no step before text: no split.
- `tool.request` before a split, `tool.outcome` after: outcome lands on the original segment.
- failed run: error goes on the last run segment; existing `runFinished.test.ts` updated, still green.

## Docs
`ARCHITECTURE_NOW.md` webview row: segments, Q&A item, final block.
