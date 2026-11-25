import { describe, expect, it, vi } from "vitest";
import { onEvent, type EventCtx } from "../src/taskEvents.js";
import type { AgentDef } from "@stewart/config";

describe("diag engine event", () => {
  it("is logged as `tag: detail` and emits no bus event", async () => {
    const log = vi.fn();
    const emit = vi.fn();
    const c = { spec: { runId: "r", role: { id: "lead" }, run: { seq: 0 } }, deps: { bus: { emit }, host: { log } } } as unknown as EventCtx;
    await onEvent({ kind: "diag", tag: "reasoning_overrun", detail: "21000 chars" }, c, {} as AgentDef);
    expect(log).toHaveBeenCalledWith("reasoning_overrun: 21000 chars");
    expect(emit).not.toHaveBeenCalled();
  });
});
