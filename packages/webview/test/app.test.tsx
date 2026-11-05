import { afterEach, describe, expect, it } from "vitest";
import { cleanup } from "@testing-library/preact";
import { render, screen, fireEvent, act } from "@testing-library/preact";
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

describe("webview chat", () => {
  it("sends a user message and streams the assistant reply", async () => {
    const { bridge, store } = mk();
    fireEvent.input(screen.getByPlaceholderText("Ask Stewart"), { target: { value: "hello" } });
    fireEvent.click(screen.getByText("Send"));
    expect(bridge.sent).toContainEqual({ type: "chat.send", text: "hello" });

    act(() => {
      bridge.inbound(ev("run.started", { title: "hello" }));
      bridge.inbound(ev("text_delta", { seq: 0, text: "hi " }));
      bridge.inbound(ev("text_delta", { seq: 1, text: "there" }));
      bridge.inbound(ev("run.finished", { status: "done" }));
    });
    expect(screen.getByText("hello")).toBeTruthy();
    expect(screen.getByText("hi there")).toBeTruthy();
    expect(store.state.busyRunId).toBeUndefined();
  });

  it("shows Stop while busy and posts chat.cancel", () => {
    const { bridge } = mk();
    act(() => {
      bridge.inbound(ev("run.started", { title: "x" }));
    });
    fireEvent.click(screen.getByText("Stop"));
    expect(bridge.sent).toContainEqual({ type: "chat.cancel", runId: "r1" });
  });

  it("renders an approval card and posts the grant", () => {
    const { bridge, store } = mk();
    act(() => {
      bridge.inbound(ev("run.started", { title: "x" }));
      bridge.inbound(ev("approval.request", { approvalId: "a1", tool: "RunTerminal", args: { cmd: "ls" }, category: "COMMANDS" }));
    });
    fireEvent.click(screen.getByText("Always"));
    expect(bridge.sent).toContainEqual({ type: "chat.approve", approvalId: "a1", grant: "always" });
    expect(store.state.approvals).toHaveLength(0);
  });

  it("renders a question card and posts the answer", () => {
    const { bridge } = mk();
    act(() => {
      bridge.inbound(ev("run.started", { title: "x" }));
      bridge.inbound(ev("ask_user", { questionId: "q1", question: "Continue?", options: ["yes", "no"] }));
    });
    fireEvent.click(screen.getByText("yes"));
    expect(bridge.sent).toContainEqual({ type: "chat.answer", questionId: "q1", answer: "yes" });
  });

  it("marks failed runs in the transcript", () => {
    const { bridge } = mk();
    act(() => {
      bridge.inbound(ev("run.started", { title: "x" }));
      bridge.inbound(ev("run.finished", { status: "failed", error: "boom" }));
    });
    expect(screen.getByText("boom")).toBeTruthy();
  });
});

describe("webview settings", () => {
  const configReply = {
    type: "config" as const,
    files: { "channels.yaml": "version: 1\nitems: []\n" },
    summary: {
      channels: [{ id: "c1", type: "ollama", enabled: true, baseUrl: "http://x" }],
      agents: [{ id: "a1", channel: "c1", model: "m", effort: "medium" }],
      roles: [{ id: "general-worker", enabled: true, agent: "a1" }],
      settings: { costLimit: { perRunUsd: 5, onLimit: "ask" } },
    },
    errors: [],
  };

  it("renders channels from config reply and edits + saves a field", async () => {
    const { bridge } = mk();
    fireEvent.click(screen.getAllByText("Settings")[0]);
    act(() => bridge.inbound(configReply));
    expect(screen.getByText("c1")).toBeTruthy();
    fireEvent.click(screen.getByText("Edit"));
    const input = screen.getByPlaceholderText("http://localhost:11434");
    fireEvent.input(input, { target: { value: "http://new" } });
    fireEvent.click(screen.getByText("Save"));
    const setMsg = bridge.sent.find((m) => m.type === "config.set");
    expect(setMsg && setMsg.type === "config.set" && setMsg.file).toBe("channels.yaml");
    expect(setMsg && setMsg.type === "config.set" && setMsg.yaml).toContain("http://new");
  });

  it("sends channel.test and renders the result", async () => {
    const { bridge } = mk();
    fireEvent.click(screen.getAllByText("Settings")[0]);
    act(() => bridge.inbound(configReply));
    fireEvent.click(screen.getByText("Test"));
    expect(bridge.sent).toContainEqual({ type: "channel.test", channelId: "c1" });
    act(() => bridge.inbound({ type: "channel.test.result", channelId: "c1", ok: true, models: ["m1", "m2"] }));
    expect(screen.getByText(/m1, m2/)).toBeTruthy();
  });

  it("shows config errors", () => {
    const { bridge } = mk();
    fireEvent.click(screen.getAllByText("Settings")[0]);
    act(() => bridge.inbound({ ...configReply, errors: ["channels.yaml: bad"] }));
    expect(screen.getByText(/channels.yaml: bad/)).toBeTruthy();
  });
});
