import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/preact";
import { App } from "../src/App.js";
import { Store } from "../src/state.js";
import { MockBridge, type ConfigReply, type RoleSummary } from "../src/bridge.js";

afterEach(cleanup);

const reply = (roles: RoleSummary[]): { type: "config" } & ConfigReply => ({
  type: "config",
  files: {},
  summary: {
    channels: [{ id: "c1", type: "ollama", enabled: true }],
    agents: [{ id: "a1", channel: "c1", model: "m" }],
    roles, skills: [],
    settings: {},
  },
  errors: [],
});

function mk(roles: RoleSummary[]) {
  const bridge = new MockBridge();
  const store = new Store(bridge);
  render(<App store={store} />);
  act(() => bridge.inbound(reply(roles)));
  return { bridge, store };
}

describe("chat no-lead empty state", () => {
  it("shows actions when no agent-kind role is enabled", () => {
    mk([{ id: "lead", enabled: false }, { id: "w", enabled: true, kind: "function" }]);
    expect(screen.getByText(/Chat is unavailable/)).toBeTruthy();
    fireEvent.click(screen.getByText("Add defaults"));
    expect((screen.getAllByText("Add defaults")[0] as HTMLButtonElement)).toBeTruthy();
  });

  it("Add defaults posts roles.addDefaults; Run setup opens the wizard in settings", () => {
    const { bridge, store } = mk([]);
    fireEvent.click(screen.getByText("Add defaults"));
    expect(bridge.sent.some((m) => m.type === "roles.addDefaults")).toBe(true);
    fireEvent.click(screen.getByText("Run setup"));
    expect(store.state.wizardOpen).toBe(true);
    expect(store.state.view).toBe("settings");
  });

  it("hidden when an enabled agent-kind role exists", () => {
    mk([{ id: "lead", enabled: true, agent: "a1" }]);
    expect(screen.queryByText(/Chat is unavailable/)).toBeNull();
  });
});

describe("unbound enabled role warning", () => {
  it("warns that an enabled unbound role runs on the lead's agent", () => {
    mk([
      { id: "lead", enabled: true, agent: "a1" },
      { id: "reviewer", enabled: true },
      { id: "off", enabled: false },
    ]);
    fireEvent.click(screen.getAllByText("Settings")[0]);
    fireEvent.click(screen.getByText("roles"));
    expect(screen.getByText(/unbound: runs on the lead's agent/)).toBeTruthy();
    expect(screen.getAllByText(/unbound: runs on the lead's agent/)).toHaveLength(1);
  });
});
