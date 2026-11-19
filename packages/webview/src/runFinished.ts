import type { RunEvent } from "@stewart/protocol";
import type { ChatItem } from "./stateTypes.js";
import { itemRunId, lastRunIndex, splitFinal } from "./segments.js";

type Finished = Extract<RunEvent, { kind: "run.finished" }>;

/** One short run-status line from run.finished's outcome. */
function outcomeText(o: { changed: string[]; verified: "command" | "files" | "none"; command?: string; tracking?: string; trackingReason?: string }): string {
  if (o.tracking === "unavailable") return `File changes not tracked${o.trackingReason ? `: ${o.trackingReason}` : ""}`;
  if (!o.changed.length) return "No files changed";
  const n = `Changed ${o.changed.length} file${o.changed.length === 1 ? "" : "s"}`;
  if (o.verified === "command") return `${n}; verified: ${o.command}`;
  if (o.verified === "files") return `${n}; required files present`;
  return `${n}, not verified`;
}

function markRunItem(items: ChatItem[], ev: Finished): ChatItem[] {
  const files = ev.outcome && ev.outcome.changed.length ? ev.outcome.changed : undefined;
  const baseline = ev.outcome?.baseline;
  const lastIdx = lastRunIndex(items, ev.runId);
  return items.map((i, idx) =>
    itemRunId(i) === ev.runId
      ? { ...i, streaming: false, ...(idx === lastIdx && files ? { filesChanged: files } : {}), ...(idx === lastIdx && baseline ? { filesBaseline: baseline } : {}) }
      : i,
  );
}

function applyFailure(items: ChatItem[], ev: Finished, nextSeq: () => number): ChatItem[] {
  const last = items[items.length - 1];
  if (ev.status !== "done" && (!last || itemRunId(last) !== ev.runId)) {
    return [...items, { id: `sys${nextSeq()}`, role: "system" as const, text: ev.error ?? ev.status, activity: [] }];
  }
  if (ev.status !== "done" && ev.error && last) {
    return items.map((i, idx) => (idx === items.length - 1 ? { ...i, streaming: false, text: i.text || ev.error! } : i));
  }
  return items;
}

function appendOutcome(items: ChatItem[], ev: Finished, nextSeq: () => number): ChatItem[] {
  if (!ev.outcome) return items;
  return [
    ...items,
    { id: `sys${nextSeq()}`, role: "system" as const, text: outcomeText(ev.outcome), activity: [], revertTurn: ev.status === "failed" || undefined },
  ];
}

export function finishedItems(items: ChatItem[], ev: Finished, nextSeq: () => number): ChatItem[] {
  return appendOutcome(applyFailure(markRunItem(splitFinal(items, ev.runId), ev), ev, nextSeq), ev, nextSeq);
}
