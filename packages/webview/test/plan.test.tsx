import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, fireEvent, act } from "@testing-library/preact";
import { App } from "../src/App.js";
import { Store } from "../src/state.js";
import { MockBridge } from "../src/bridge.js";

afterEach(cleanup);

function mk() {
  const bridge = new MockBridge();
  const store = new Store(bridge);
  render(<App store={store} />);
  return { bridge, store };
}

const ev = (kind: string, extra: Record<string, unknown> = {}) => ({ type: "event" as const, ev: { kind, runId: "r1", ...extra } as never });

const startPlan = (bridge: MockBridge) => {
  bridge.inbound(ev("run.started", { title: "x" }));
  bridge.inbound(ev("plan.approved", { milestoneCount: 2 }));
  bridge.inbound(ev("milestone.started", { milestoneId: "m1", title: "first" }));
  bridge.inbound(ev("milestone.started", { milestoneId: "m2", title: "second" }));
};

const kids = () => [...document.querySelector(".items")!.children];
const planIdx = () => kids().findIndex((el) => el.classList.contains("plan"));
const itemIdx = (needle: string) => kids().findIndex((el) => el.textContent?.includes(needle));

describe("plan card", () => {
  it("pins the live plan, then anchors it into the transcript when the last milestone completes", () => {
    const { bridge, store } = mk();
    act(() => startPlan(bridge));
    expect(store.state.plan?.active).toBe(true);
    expect(document.querySelector(".card.plan")).toBeTruthy();

    act(() => {
      bridge.inbound(ev("milestone.done", { milestoneId: "m1" }));
    });
    expect(store.state.plan?.active).toBe(true);

    act(() => {
      bridge.inbound(ev("milestone.done", { milestoneId: "m2" }));
      bridge.inbound(ev("run.finished", { status: "done" }));
    });
    expect(store.state.plan).toBeUndefined();
    const anchored = store.state.items.find((i) => i.plan);
    expect(anchored?.plan?.milestones.map((m) => m.status)).toEqual(["done", "done"]);

    act(() => store.send("next question"));
    expect(planIdx()).toBeGreaterThanOrEqual(0);
    expect(itemIdx("next question")).toBeGreaterThan(planIdx());
  });

  it("keeps a failed plan pinned and resumable instead of anchoring it", () => {
    const { bridge, store } = mk();
    act(() => {
      startPlan(bridge);
      bridge.inbound(ev("milestone.failed", { milestoneId: "m1", error: "boom" }));
    });
    expect(store.state.plan?.active).toBe(true);
    expect(store.state.items.every((i) => !i.plan)).toBe(true);
    expect(screen.getByText("Resume plan")).toBeTruthy();
  });

  it("clears the plan card on New chat", () => {
    const { bridge, store } = mk();
    act(() => {
      startPlan(bridge);
      bridge.inbound(ev("run.finished", { status: "done" }));
    });
    expect(document.querySelector(".card.plan")).toBeTruthy();
    fireEvent.click(screen.getByText("New chat"));
    expect(store.state.plan).toBeUndefined();
    expect(store.state.items).toEqual([]);
    expect(document.querySelector(".card.plan")).toBeNull();
  });

  it("anchors a completed plan restored from history instead of pinning it", () => {
    const { bridge, store } = mk();
    act(() =>
      bridge.inbound({
        type: "history.messages",
        sessionId: "s1",
        messages: [{ role: "user", content: "earlier" }],
        plan: { goal: "g", status: "done", milestones: [{ id: "m1", title: "t", status: "done" }] },
      }),
    );
    expect(store.state.plan).toBeUndefined();
    expect(store.state.items.at(-1)?.plan?.goal).toBe("g");

    act(() => store.send("more"));
    expect(itemIdx("more")).toBeGreaterThan(planIdx());
  });

  it("keeps an active plan restored from history pinned for resume", () => {
    const { bridge, store } = mk();
    act(() =>
      bridge.inbound({
        type: "history.messages",
        sessionId: "s1",
        messages: [{ role: "user", content: "earlier" }],
        plan: { goal: "g", status: "paused", milestones: [{ id: "m1", title: "t", status: "pending" }] },
      }),
    );
    expect(store.state.plan?.active).toBe(true);
    expect(store.state.items.every((i) => !i.plan)).toBe(true);
  });
});
