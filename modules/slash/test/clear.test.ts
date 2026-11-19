import { describe, expect, it } from "vitest";
import { runSlash } from "../src/api.js";
import { locals, makeDeps, REGISTRY } from "./helpers.js";

describe("/clear", () => {
  it("is listed in /help output", async () => {
    const { deps, events } = makeDeps();
    await runSlash(REGISTRY, deps, "/help");
    expect(locals(events).join("\n")).toContain("/clear");
  });

  it("clears the session via the injected hook and reports success", async () => {
    const { deps, events, cleared } = makeDeps();
    expect(await runSlash(REGISTRY, deps, "/clear", "sess-1")).toBe(true);
    expect(cleared).toEqual(["sess-1"]);
    expect(locals(events)[0]).toContain("Cleared");
    expect(events.some((e) => e.kind === "chat.cleared")).toBe(false);
  });

  it("ignores unknown args and still clears", async () => {
    const { deps, events, cleared } = makeDeps();
    await runSlash(REGISTRY, deps, "/clear now please", "sess-1");
    expect(cleared).toEqual(["sess-1"]);
    expect(locals(events)[0]).toContain("Cleared");
  });

  it("reports the hook's failure reason", async () => {
    const { deps, events, cleared } = makeDeps();
    deps.session.clear = async (sessionId) => {
      cleared.push(sessionId ?? "");
      return { ok: false, reason: "a run is active for this session" };
    };
    await runSlash(REGISTRY, deps, "/clear", "sess-1");
    expect(cleared).toEqual(["sess-1"]);
    expect(locals(events)[0]).toContain("a run is active for this session");
  });

  it("a rejecting hook surfaces as /clear failed via the central capture", async () => {
    const { deps, events } = makeDeps();
    deps.session.clear = async () => {
      throw new Error("disk gone");
    };
    expect(await runSlash(REGISTRY, deps, "/clear", "sess-1")).toBe(true);
    expect(locals(events)).toEqual(["/clear failed: disk gone"]);
  });

  it("answers locally without a session and never calls the hook", async () => {
    const { deps, events, cleared } = makeDeps();
    await runSlash(REGISTRY, deps, "/clear");
    expect(cleared).toEqual([]);
    expect(locals(events)[0]).toContain("no session yet");
  });
});
