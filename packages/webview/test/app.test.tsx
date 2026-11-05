import { describe, expect, it } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/preact";
import { App } from "../src/App.js";
import { Store } from "../src/state.js";
import { MockBridge } from "../src/bridge.js";

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
