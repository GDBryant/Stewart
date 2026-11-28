import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, fireEvent, act } from "@testing-library/preact";
import { App } from "../src/App.js";
import { Store } from "../src/state.js";
import { MockBridge } from "../src/bridge.js";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function mk() {
  const bridge = new MockBridge();
  const store = new Store(bridge);
  render(<App store={store} />);
  return { bridge, store };
}

const ev = (kind: string, extra: Record<string, unknown> = {}) => ({ type: "event" as const, ev: { kind, runId: "r1", ...extra } as never });
const ta = () => screen.getByPlaceholderText(/Ask Stewart|Guide this run/) as HTMLTextAreaElement;
const busyRun = (bridge: MockBridge) => act(() => bridge.inbound(ev("run.started", { title: "x" })));
const type = (text: string) => fireEvent.input(ta(), { target: { value: text } });
const sent = (bridge: MockBridge, type: string) => bridge.sent.filter((m) => m.type === type);

describe("composer steer", () => {
  it("busy Enter posts chat.steer, not chat.send", () => {
    const { bridge } = mk();
    busyRun(bridge);
    type("use file b");
    fireEvent.keyDown(ta(), { key: "Enter" });
    expect(sent(bridge, "chat.steer")).toContainEqual(expect.objectContaining({ runId: "r1", text: "use file b" }));
    expect(sent(bridge, "chat.send")).toHaveLength(0);
    expect(ta().value).toBe("");
  });

  it("busy Ctrl+Enter queues without posting chat.send", () => {
    const { bridge, store } = mk();
    busyRun(bridge);
    type("do this after");
    fireEvent.keyDown(ta(), { key: "Enter", ctrlKey: true });
    expect(sent(bridge, "chat.send")).toHaveLength(0);
    expect(store.state.outbox).toHaveLength(1);
    expect(store.state.outbox[0].text).toBe("do this after");
    expect(document.querySelector(".outbox")).toBeTruthy();
  });

  it("idle Ctrl+Enter sends normally", () => {
    const { bridge } = mk();
    type("hello");
    fireEvent.keyDown(ta(), { key: "Enter", ctrlKey: true });
    expect(sent(bridge, "chat.send")).toContainEqual(expect.objectContaining({ text: "hello" }));
  });

  it("Shift+Enter inserts a newline and sends nothing", () => {
    const { bridge } = mk();
    busyRun(bridge);
    type("line");
    fireEvent.keyDown(ta(), { key: "Enter", shiftKey: true });
    expect(sent(bridge, "chat.steer")).toHaveLength(0);
    expect(sent(bridge, "chat.send")).toHaveLength(0);
  });

  it("a known slash command queues rather than steering while busy", () => {
    const { bridge, store } = mk();
    act(() => bridge.inbound({ type: "slash.commands", commands: [{ name: "clear", argHint: "", description: "d" }] }));
    busyRun(bridge);
    act(() => store.submit("/clear"));
    expect(sent(bridge, "chat.steer")).toHaveLength(0);
    expect(store.state.outbox.map((o) => o.text)).toEqual(["/clear"]);
  });

  it("an unknown leading slash stays literal guidance", () => {
    const { bridge, store } = mk();
    busyRun(bridge);
    type("/tmp/log tail it");
    fireEvent.keyDown(ta(), { key: "Enter" });
    expect(sent(bridge, "chat.steer")).toContainEqual(expect.objectContaining({ text: "/tmp/log tail it" }));
    expect(store.state.outbox).toHaveLength(0);
  });

  it("busy mode shows the Guide/Queue/Stop buttons and hint", () => {
    const { bridge } = mk();
    busyRun(bridge);
    expect(screen.getByText("Guide")).toBeTruthy();
    expect(screen.getByText("Queue")).toBeTruthy();
    expect(screen.getByText("Stop")).toBeTruthy();
    expect(document.getElementById("composer-hint")?.textContent).toContain("Enter guides");
    expect(ta().getAttribute("aria-describedby")).toBe("composer-hint");
    expect(ta().placeholder).toBe("Guide this run…");
  });

  it("steer ok closes the assistant segment and appends a guidance bubble", () => {
    const { bridge, store } = mk();
    busyRun(bridge);
    act(() => store.setDraft("nudge"));
    act(() => store.submit("nudge"));
    act(() => bridge.inbound({ type: "chat.steer.result", ok: true }));
    const g = store.state.items.at(-1);
    expect(g).toMatchObject({ role: "user", text: "nudge", guidance: true });
    expect(screen.getByText("user · guidance")).toBeTruthy();
    expect(screen.getByText("sent while the run was active")).toBeTruthy();
  });

  it("steer failure queues an escaped follow-up and shows the warning", () => {
    const { bridge, store } = mk();
    busyRun(bridge);
    act(() => store.submit("/clear"));
    act(() => bridge.inbound({ type: "chat.steer.result", ok: false, reason: "engine unsupported" }));
    expect(store.state.outbox[0].text).toBe("//clear");
    expect(store.state.steerWarning).toContain("this agent can't take guidance mid-run");
  });

  it("steer timeout restores the text before a newer draft and shows a warning", () => {
    vi.useFakeTimers();
    const { bridge, store } = mk();
    busyRun(bridge);
    act(() => store.submit("lost steer"));
    act(() => store.setDraft("newer draft"));
    act(() => { vi.advanceTimersByTime(3100); });
    expect(store.state.draft).toBe("lost steer\nnewer draft");
    expect(store.state.steerWarning).toContain("No confirmation");
    expect(store.state.steerPending).toBe(false);
  });
});

describe("outbox", () => {
  const queueOne = (bridge: MockBridge, text = "after this") => {
    busyRun(bridge);
    type(text);
    fireEvent.keyDown(ta(), { key: "Enter", ctrlKey: true });
  };

  it("pumps the head after run.finished and appends the bubble on ok", () => {
    const { bridge, store } = mk();
    queueOne(bridge);
    expect(sent(bridge, "chat.send")).toHaveLength(0);
    act(() => bridge.inbound(ev("run.finished", { status: "done" })));
    expect(sent(bridge, "chat.send")).toContainEqual(expect.objectContaining({ text: "after this" }));
    expect(store.state.outbox[0].status).toBe("sending");
    act(() => bridge.inbound({ type: "chat.send.result", ok: true, runId: "r2" }));
    expect(store.state.outbox).toHaveLength(0);
    expect(store.state.items.at(-1)).toMatchObject({ role: "user", text: "after this" });
  });

  it("a dispatched runId holds the outbox until its run.started", () => {
    const { bridge, store } = mk();
    queueOne(bridge);
    act(() => bridge.inbound(ev("run.finished", { status: "done" })));
    act(() => bridge.inbound({ type: "chat.send.result", ok: true, runId: "r2" }));
    expect(store.state.outboxSending).toBe(true);
    type("second");
    act(() => store.submit("second", true));
    act(() => bridge.inbound(ev("run.started", { runId: "r2" })));
    expect(store.state.outboxSending).toBeUndefined();
    act(() => bridge.inbound(ev("run.finished", { status: "done", runId: "r2" })));
    expect(sent(bridge, "chat.send").map((m) => (m as { text: string }).text)).toContain("second");
  });

  it("send failure pauses the head as failed with retry, no silent cascade", () => {
    const { bridge, store } = mk();
    queueOne(bridge, "first");
    type("second");
    act(() => store.submit("second", true));
    act(() => bridge.inbound(ev("run.finished", { status: "done" })));
    act(() => bridge.inbound({ type: "chat.send.result", ok: false, error: "no lead" }));
    expect(store.state.outbox[0]).toMatchObject({ text: "first", status: "failed", error: "no lead" });
    expect(sent(bridge, "chat.send")).toHaveLength(1);
    fireEvent.click(screen.getByText("Retry"));
    expect(sent(bridge, "chat.send")).toHaveLength(2);
  });

  it("send timeout pauses with a duplicate warning", () => {
    vi.useFakeTimers();
    const { bridge, store } = mk();
    queueOne(bridge);
    act(() => bridge.inbound(ev("run.finished", { status: "done" })));
    act(() => { vi.advanceTimersByTime(3100); });
    expect(store.state.outbox[0].status).toBe("failed");
    expect(store.state.outbox[0].error).toContain("retry can duplicate");
    expect(sent(bridge, "chat.send")).toHaveLength(1);
  });

  it("slash output (no runId) releases the outbox immediately", () => {
    const { bridge, store } = mk();
    queueOne(bridge, "/clear");
    type("second");
    act(() => store.submit("second", true));
    act(() => bridge.inbound(ev("run.finished", { status: "done" })));
    act(() => bridge.inbound({ type: "chat.send.result", ok: true }));
    expect(sent(bridge, "chat.send").map((m) => (m as { text: string }).text)).toEqual(["/clear", "second"]);
  });

  it("edit moves an item back into the composer; remove discards it", () => {
    const { bridge, store } = mk();
    queueOne(bridge);
    fireEvent.click(screen.getByText("Edit"));
    expect(store.state.outbox).toHaveLength(0);
    expect(store.state.draft).toBe("after this");
    act(() => store.submit("after this", true));
    expect(store.state.outbox).toHaveLength(1);
    const remove = document.querySelector(".outbox-row .deny") as HTMLButtonElement;
    fireEvent.click(remove);
    expect(store.state.outbox).toHaveLength(0);
  });

  it("chat.cleared drops unsent items", () => {
    const { bridge, store } = mk();
    queueOne(bridge);
    act(() => bridge.inbound(ev("chat.cleared", { sessionId: store.state.sessionId })));
    expect(store.state.outbox).toHaveLength(0);
  });

  it("history load strips the guidance marker and flags the item", () => {
    const { bridge, store } = mk();
    act(() =>
      bridge.inbound({
        type: "history.messages",
        sessionId: "s1",
        messages: [{ role: "user", content: "<stewart-guidance>mid run" }],
      }),
    );
    expect(store.state.items[0]).toMatchObject({ role: "user", text: "mid run", guidance: true });
    expect(screen.getByText("user · guidance")).toBeTruthy();
  });
});

describe("session lock", () => {
  it("New chat is disabled while a run is active or items are queued", () => {
    const { bridge } = mk();
    const btn = () => screen.getByText("New chat") as HTMLButtonElement;
    expect(btn().disabled).toBe(false);
    busyRun(bridge);
    expect(btn().disabled).toBe(true);
    act(() => bridge.inbound(ev("run.finished", { status: "done" })));
    expect(btn().disabled).toBe(false);
  });
});
