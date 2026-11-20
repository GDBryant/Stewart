import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/preact";
import { App } from "../src/App.js";
import { Store } from "../src/state.js";
import { MockBridge, type ConfigReply } from "../src/bridge.js";

afterEach(cleanup);

function mk() {
  const bridge = new MockBridge();
  const store = new Store(bridge);
  render(<App store={store} />);
  return { bridge, store };
}

const configReply: { type: "config" } & ConfigReply = {
  type: "config" as const,
  files: {},
  summary: {
    channels: [{ id: "c1", type: "ollama", enabled: true }],
    agents: [{ id: "a1", channel: "c1", model: "m1", effort: "medium" }],
    roles: [],
    skills: [],
    settings: {},
  },
  errors: [],
};

const openSettings = (bridge: MockBridge) => {
  fireEvent.click(screen.getAllByText("Settings")[0]);
  act(() => bridge.inbound(configReply));
};

describe("models refresh", () => {
  it("posts models.refresh once per click and latches while busy", () => {
    const { bridge, store } = mk();
    store.refreshModels();
    store.refreshModels();
    expect(bridge.sent.filter((m) => m.type === "models.refresh")).toHaveLength(1);
    expect(store.state.refreshBusy).toBe(true);
  });

  it("on result refreshes config and summarizes the changes", () => {
    const { bridge, store } = mk();
    store.refreshModels();
    act(() =>
      bridge.inbound({ type: "models.refresh.result", ok: true, added: ["c1-m2", "c1-m3"], removed: ["a9"], unreachable: ["c2"] }),
    );
    expect(bridge.sent).toContainEqual({ type: "config.get" });
    expect(store.state.refreshBusy).toBe(false);
    expect(store.state.refreshSummary).toBe("models refresh: +2 agents, 1 removed, 1 channel unreachable");
  });

  it("reports failure on lastError and unlatches", () => {
    const { bridge, store } = mk();
    store.refreshModels();
    act(() => bridge.inbound({ type: "models.refresh.result", ok: false, error: "models refresh already running" }));
    expect(store.state.refreshBusy).toBe(false);
    expect(store.state.lastError).toBe("models refresh already running");
    expect(store.state.refreshSummary).toBeUndefined();
  });

  it("shows a Refresh models button in Settings that triggers the flow", () => {
    const { bridge } = mk();
    openSettings(bridge);
    fireEvent.click(screen.getByText("Refresh models"));
    expect(bridge.sent).toContainEqual({ type: "models.refresh" });
  });

  it("renders refresh question cards in Settings and answers via buttons", () => {
    const { bridge } = mk();
    openSettings(bridge);
    act(() =>
      bridge.inbound({
        type: "event",
        ev: { kind: "ask_user", runId: "sync1", questionId: "q1", question: "channel 'c1' is unreachable.", options: ["Keep", "Retry once"] } as never,
      }),
    );
    fireEvent.click(screen.getByText("Retry once"));
    expect(bridge.sent).toContainEqual({ type: "chat.answer", questionId: "q1", answer: "Retry once" });
  });
});
