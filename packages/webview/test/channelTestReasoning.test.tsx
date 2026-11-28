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
    channels: [{ id: "c1", type: "openai-compatible", enabled: true, baseUrl: "http://x" }],
    agents: [], roles: [], skills: [],
    settings: {},
  },
  errors: [],
};

function mk() {
  const bridge = new MockBridge();
  const store = new Store(bridge);
  render(<App store={store} />);
  fireEvent.click(screen.getAllByText("Settings")[0]);
  act(() => bridge.inbound(reply));
  return { bridge };
}

const result = (reasoning?: { suggest?: "reasoning_effort" | "enable_thinking" | "none"; control?: boolean }) =>
  ({ type: "channel.test.result", channelId: "c1", ok: true, models: ["m1"], reasoning }) as { type: "channel.test.result"; channelId: string; ok: boolean; models: string[]; reasoning?: { suggest?: "reasoning_effort" | "enable_thinking" | "none"; control?: boolean } };

describe("channel test reasoning note", () => {
  it("suggests a reasoning field when the probe found one", () => {
    const { bridge } = mk();
    act(() => bridge.inbound(result({ suggest: "reasoning_effort" })));
    expect(screen.getByText("· reasoning: set reasoning_effort")).toBeTruthy();
  });

  it("marks a configured field as working or ineffective", () => {
    const { bridge } = mk();
    act(() => bridge.inbound(result({ control: true })));
    expect(screen.getByText("· reasoning field works")).toBeTruthy();
    act(() => bridge.inbound(result({ control: false })));
    expect(screen.getByText("· reasoning field ineffective")).toBeTruthy();
  });

  it("shows nothing extra without reasoning info", () => {
    const { bridge } = mk();
    act(() => bridge.inbound(result(undefined)));
    expect(screen.getByText(/✓/)).toBeTruthy();
    expect(screen.queryByText(/reasoning/)).toBeNull();
  });
});
