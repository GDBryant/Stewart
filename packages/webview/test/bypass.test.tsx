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
const approval = (id: string) => ({
  type: "event" as const,
  ev: { kind: "approval.request", runId: "r1", approvalId: id, tool: "RunTerminal", args: {}, category: "COMMANDS" } as never,
});

describe("bypass toggle", () => {
  it("queries bypass on ready and renders OFF by default", () => {
    const { bridge } = mk();
    expect(bridge.sent).toContainEqual({ type: "permissions.bypass" });
    const b = screen.getByText("Bypass is OFF");
    expect(b.className).toBe("small");
    expect(b.getAttribute("aria-pressed")).toBe("false");
    expect(b.getAttribute("title")).toBe("Auto-approve all tool calls");
  });

  it("click posts the inverted desired value", () => {
    const { bridge } = mk();
    fireEvent.click(screen.getByText("Bypass is OFF"));
    expect(bridge.sent).toContainEqual({ type: "permissions.bypass", on: true });
    act(() => bridge.inbound({ type: "permissions.bypass.result", on: true }));
    fireEvent.click(screen.getByText("Bypass is ON"));
    expect(bridge.sent).toContainEqual({ type: "permissions.bypass", on: false });
  });

  it("result ON renders red pressed button and approves pending cards once", () => {
    const { bridge, store } = mk();
    act(() => {
      bridge.inbound(approval("a1"));
      bridge.inbound(approval("a2"));
    });
    expect(store.state.approvals).toHaveLength(2);
    act(() => bridge.inbound({ type: "permissions.bypass.result", on: true }));
    const b = screen.getByText("Bypass is ON");
    expect(b.className).toContain("deny");
    expect(b.getAttribute("aria-pressed")).toBe("true");
    expect(store.state.bypass).toBe(true);
    expect(store.state.approvals).toHaveLength(0);
    expect(bridge.sent).toContainEqual({ type: "chat.approve", approvalId: "a1", grant: "once" });
    expect(bridge.sent).toContainEqual({ type: "chat.approve", approvalId: "a2", grant: "once" });
  });

  it("result OFF leaves pending approvals untouched", () => {
    const { bridge, store } = mk();
    act(() => bridge.inbound(approval("a1")));
    act(() => bridge.inbound({ type: "permissions.bypass.result", on: false }));
    expect(store.state.bypass).toBe(false);
    expect(store.state.approvals).toHaveLength(1);
    expect(bridge.sent.some((m) => m.type === "chat.approve")).toBe(false);
  });
});

describe("sidecar.ready", () => {
  it("clears the start error and re-posts load-time requests", () => {
    const { bridge, store } = mk();
    act(() => bridge.inbound({ type: "error", message: "sidecar not running" }));
    expect(store.state.lastError).toBe("sidecar not running");
    bridge.sent.length = 0;
    act(() => bridge.inbound({ type: "sidecar.ready" }));
    expect(store.state.lastError).toBeUndefined();
    expect(bridge.sent).toEqual([{ type: "ready" }, { type: "permissions.bypass" }, { type: "slash.list" }, { type: "config.get" }]);
  });

  it("is idempotent and keeps chat items", () => {
    const { bridge, store } = mk();
    store.send("hi");
    const n = store.state.items.length;
    act(() => bridge.inbound({ type: "sidecar.ready" }));
    act(() => bridge.inbound({ type: "sidecar.ready" }));
    expect(store.state.items).toHaveLength(n);
  });

  it("is not sent by the webview before the link is up (only load-time posts)", () => {
    const { bridge } = mk();
    expect(bridge.sent.filter((m) => m.type === "config.get")).toHaveLength(0);
  });
});
