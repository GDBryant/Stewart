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
const ta = () => screen.getByPlaceholderText("Ask Stewart") as HTMLTextAreaElement;
const roundTrip = () => {
  fireEvent.click(screen.getByText("Settings"));
  fireEvent.click(screen.getByText("Chat"));
};

describe("composer draft across view switches", () => {
  it("keeps typed text when switching Chat -> Settings -> Chat", () => {
    mk();
    fireEvent.input(ta(), { target: { value: "draft text" } });
    roundTrip();
    expect(ta().value).toBe("draft text");
  });

  it("keeps text and a pending image across a view switch", () => {
    const { store } = mk();
    fireEvent.input(ta(), { target: { value: "with image" } });
    act(() => store.addImage("data:image/png;base64,aGk="));
    roundTrip();
    expect(ta().value).toBe("with image");
    expect(store.state.pendingImages).toHaveLength(1);
    expect(document.querySelector(".pending-img")).toBeTruthy();
  });

  it("Enter sends the draft, clears it, and it stays empty after a view round-trip", () => {
    const { bridge, store } = mk();
    fireEvent.input(ta(), { target: { value: "send me" } });
    fireEvent.keyDown(ta(), { key: "Enter" });
    expect(bridge.sent).toContainEqual(expect.objectContaining({ type: "chat.send", text: "send me" }));
    expect(ta().value).toBe("");
    expect(store.state.draft).toBe("");
    roundTrip();
    expect(ta().value).toBe("");
    expect(store.state.draft).toBe("");
  });

  it("rejects send while busy and keeps the draft", () => {
    const { bridge, store } = mk();
    fireEvent.input(ta(), { target: { value: "still here" } });
    act(() => bridge.inbound(ev("run.started", { title: "x" })));
    act(() => store.send(store.state.draft));
    expect(bridge.sent.filter((m) => m.type === "chat.send")).toHaveLength(0);
    expect(store.state.draft).toBe("still here");
  });

  it("insertText appends to an existing draft after a view switch", () => {
    const { bridge } = mk();
    fireEvent.input(ta(), { target: { value: "existing" } });
    roundTrip();
    act(() => bridge.inbound({ type: "insertText", text: "added" }));
    expect(ta().value).toBe("existing\nadded");
  });
});

describe("store draft", () => {
  it("setDraft updates state and send clears it", () => {
    const { bridge, store } = mk();
    act(() => store.setDraft("hello"));
    expect(store.state.draft).toBe("hello");
    act(() => store.send(store.state.draft));
    expect(store.state.draft).toBe("");
    expect(bridge.sent).toContainEqual(expect.objectContaining({ type: "chat.send", text: "hello" }));
  });

  it("send with whitespace-only draft and no images keeps the draft and posts nothing", () => {
    const { bridge, store } = mk();
    act(() => store.setDraft("   "));
    act(() => store.send(store.state.draft));
    expect(store.state.draft).toBe("   ");
    expect(bridge.sent.filter((m) => m.type === "chat.send")).toHaveLength(0);
  });
});
