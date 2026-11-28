import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/preact";
import { App } from "../src/App.js";
import { Store } from "../src/state.js";
import { MockBridge, type ConfigReply } from "../src/bridge.js";

afterEach(cleanup);

const reply: { type: "config" } & ConfigReply = {
  type: "config",
  files: {},
  summary: {
    channels: [{ id: "c1", type: "ollama", enabled: true }],
    agents: [], roles: [], skills: [],
    settings: {},
  },
  errors: ["warning: role lead: agent 'a1' has a 32000-token window but the turn budget is 1000", "warning: role interrogator: shares model x with planner (distinctFrom)"],
};

function mk() {
  const bridge = new MockBridge();
  const store = new Store(bridge);
  render(<App store={store} />);
  fireEvent.click(screen.getAllByText("Settings")[0]);
  act(() => bridge.inbound(reply));
  return { bridge, store };
}

describe("settings warnings dismiss", () => {
  it("warnings render with a Dismiss button; clicking it hides them for the session", () => {
    mk();
    expect(screen.getByText(/32000-token window/)).toBeTruthy();
    fireEvent.click(screen.getByText("Dismiss"));
    expect(screen.queryByText(/32000-token window/)).toBeNull();
    expect(screen.queryByText(/distinctFrom/)).toBeNull();
  });

  it("dismissal survives a chat/settings view switch but the store flag is in-memory only", () => {
    const { store } = mk();
    fireEvent.click(screen.getByText("Dismiss"));
    fireEvent.click(screen.getAllByText("Chat")[0]);
    fireEvent.click(screen.getAllByText("Settings")[0]);
    expect(screen.queryByText(/32000-token window/)).toBeNull();
    expect(store.state.warningsDismissed).toBe(true);
  });
});
