import { describe, expect, it } from "vitest";
import type { LoopResult } from "@stewart/agent-loop";
import { retryInput, type RetryContext } from "../src/runSupport.js";

const UNPARSED = "<tool_call>{oops";
const completed = (content = "ok"): LoopResult => ({ kind: "completed", messages: [{ role: "assistant", content }], base: [] });
const failed = (code: string): LoopResult => ({ kind: "failed", messages: [{ role: "assistant", content: "" }], base: [], message: code, code });

function ctx(over: Partial<{ dispatchCalls: number; retried: boolean; nudged: boolean; recoveriesUsed: number; maxRecoveriesPerRun: number }> = {}): RetryContext {
  const logged: string[] = [];
  const host = {
    rt: { recoveryService: { sizeHint: "SIZE", log: (_rt: unknown, m: string) => logged.push(m) } },
    history: [{ role: "user", content: "earlier" }],
    userText: "do it",
    dispatchCalls: over.dispatchCalls ?? 0,
  };
  return {
    host: host as unknown as RetryContext["host"],
    R: { recoveriesUsed: over.recoveriesUsed ?? 0, maxRecoveriesPerRun: over.maxRecoveriesPerRun ?? 2 } as RetryContext["R"],
    flags: { retried: over.retried ?? false, nudged: over.nudged ?? false },
  };
}

const input = [{ role: "user" as const, content: "do it" }];

describe("retryInput", () => {
  it("retries a truncated reply once with the size hint appended to the user text", () => {
    const c = ctx();
    const next = retryInput(c, failed("truncated"), input);
    expect(next).toEqual([{ role: "user", content: "earlier" }, { role: "user", content: "do it\n\nSIZE" }]);
    expect(c.flags.retried).toBe(true);
    expect(c.R.recoveriesUsed).toBe(1);
  });

  it("replays the same input after an incomplete stream without a size hint", () => {
    expect(retryInput(ctx(), failed("incomplete_stream"), input)).toBe(input);
  });

  it("does not retry a second fault once already retried, and does not retry past the recovery cap", () => {
    expect(retryInput(ctx({ retried: true }), failed("truncated"), input)).toBe("return");
    const capped = ctx({ recoveriesUsed: 2, maxRecoveriesPerRun: 2 });
    expect(retryInput(capped, failed("truncated"), input)).toBe("return");
    expect(capped.R.recoveriesUsed).toBe(2);
  });

  it("nudges the format once when a non-failed reply has an unparsed call and nothing was dispatched", () => {
    const c = ctx();
    const next = retryInput(c, completed(UNPARSED), input);
    expect(next).toEqual([{ role: "user", content: "earlier" }, { role: "user", content: expect.stringContaining("do it") }]);
    expect(c.flags.nudged).toBe(true);
    expect(retryInput(c, completed(UNPARSED), input)).toBe("return");
  });

  it("returns control for clean replies, and never nudges once work was dispatched or the run failed", () => {
    expect(retryInput(ctx(), completed("plain answer"), input)).toBe("return");
    expect(retryInput(ctx({ dispatchCalls: 1 }), completed(UNPARSED), input)).toBe("return");
    expect(retryInput(ctx(), failed("other"), input)).toBe("return");
  });
});
