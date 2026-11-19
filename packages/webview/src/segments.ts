import type { ChatItem } from "./stateTypes.js";

export function itemRunId(it: ChatItem): string {
  return it.runId ?? it.id;
}

export function isOpenSegment(it: ChatItem | undefined, runId: string): boolean {
  return !!it && it.role === "assistant" && itemRunId(it) === runId && !!it.streaming;
}

export function nextSegmentId(items: ChatItem[], runId: string): string {
  const n = items.filter((i) => i.role === "assistant" && itemRunId(i) === runId).length;
  return n === 0 ? runId : `${runId}:${n}`;
}

export function appendDelta(it: ChatItem, text: string): void {
  const steps = it.activity.length;
  if (steps > (it.stepsAtText ?? 0)) {
    if (it.text) it.text += "\n\n";
    it.tailStart = it.text.length;
  }
  it.stepsAtText = steps;
  it.text += text;
}

export function closeSegment(items: ChatItem[], runId: string): ChatItem[] {
  return items.map((i, idx) =>
    idx === items.length - 1 && i.role === "assistant" && itemRunId(i) === runId ? { ...i, streaming: false } : i,
  );
}

export function lastRunIndex(items: ChatItem[], runId: string): number {
  for (let i = items.length - 1; i >= 0; i--) {
    if (itemRunId(items[i]) === runId) return i;
  }
  return -1;
}

export function splitFinal(items: ChatItem[], runId: string): ChatItem[] {
  const idx = lastRunIndex(items, runId);
  if (idx < 0) return items;
  const it = items[idx];
  const t = it.tailStart ?? 0;
  if (!(t > 0 && t < it.text.length)) return items;
  const head: ChatItem = { ...it, text: it.text.slice(0, t).trimEnd(), tailStart: undefined };
  const tail: ChatItem = { id: `${runId}:final`, runId, role: "assistant", text: it.text.slice(t), streaming: false, activity: [] };
  return [...items.slice(0, idx), head, tail, ...items.slice(idx + 1)];
}
