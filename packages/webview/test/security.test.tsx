import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/preact";
import { App } from "../src/App.js";
import { Store } from "../src/state.js";
import { MockBridge, type ConfigReply } from "../src/bridge.js";
import { activityIcon } from "../src/MessageItem.js";
import { customCount, effective, withoutOverrides, withRule } from "../src/security.js";

afterEach(cleanup);

function mk() {
  const bridge = new MockBridge();
  const store = new Store(bridge);
  render(<App store={store} />);
  return { bridge, store };
}

const reply = (over: Partial<ConfigReply["summary"]> = {}): { type: "config" } & ConfigReply => ({
  type: "config",
  files: {},
  summary: {
    channels: [
      { id: "c1", type: "openai-compatible", enabled: true, baseUrl: "http://x" },
      { id: "c2", type: "claude-cli", enabled: true, security: { passwords: false } },
      { id: "c3", type: "ollama", enabled: true, security: { privacy: false, passwords: true } },
    ],
    agents: [], roles: [], skills: [],
    settings: { runTurnLimit: 60, security: { passwords: true, privacy: true } },
    ...over,
  },
  errors: [],
});

const open = (tab: string, r = reply()) => {
  const { bridge, store } = mk();
  fireEvent.click(screen.getAllByText("Settings")[0]);
  act(() => bridge.inbound(r));
  fireEvent.click(screen.getByText(tab));
  return { bridge, store };
};
const lastSet = (bridge: MockBridge, file: string) => {
  const m = [...bridge.sent].reverse().find((x) => x.type === "config.set" && x.file === file) as { yaml: string } | undefined;
  return m ? (parse(m.yaml) as Record<string, any>) : undefined;
};

describe("security helpers", () => {
  const chs = reply().summary.channels;
  it("effective: override, else global, else on", () => {
    expect(effective({ privacy: false }, chs[0], "privacy")).toBe(false);
    expect(effective({ privacy: false }, chs[2], "privacy")).toBe(false);
    expect(effective({ passwords: true }, chs[1], "passwords")).toBe(false);
    expect(effective(undefined, undefined, "passwords")).toBe(true);
  });
  it("withRule sets, clears and drops an empty override; others untouched", () => {
    expect(withRule(chs, "c1", "privacy", false)[0].security).toEqual({ privacy: false });
    expect(withRule(chs, "c2", "passwords", undefined)[1]).not.toHaveProperty("security");
    expect(withRule(chs, "c3", "privacy", undefined)[2].security).toEqual({ passwords: true });
    expect(withRule(chs, "c1", "privacy", false)[1]).toBe(chs[1]);
  });
  it("withoutOverrides clears every override and customCount counts them", () => {
    expect(customCount(chs)).toBe(2);
    expect(customCount(withoutOverrides(chs))).toBe(0);
  });
});

describe("Settings → settings → Security", () => {
  it("shows the global defaults and saves a toggle without losing other settings", () => {
    const { bridge } = open("settings");
    const box = screen.getByText("Privacy", { selector: "span" }).parentElement!.querySelector("input")!;
    expect(box.checked).toBe(true);
    fireEvent.click(box);
    const saved = lastSet(bridge, "settings.yaml")!;
    expect(saved.security).toEqual({ passwords: true, privacy: false });
    expect(saved.runTurnLimit).toBe(60);
  });

  it("Apply to all channels asks first, then clears every override", () => {
    const { bridge } = open("settings");
    fireEvent.click(screen.getByText("Apply to all channels"));
    expect(screen.getByText(/2 channels have custom settings/)).toBeTruthy();
    expect(lastSet(bridge, "channels.yaml")).toBeUndefined();
    fireEvent.click(screen.getByText("Reset them"));
    const items = lastSet(bridge, "channels.yaml")!.items as any[];
    expect(items.map((c) => c.id)).toEqual(["c1", "c2", "c3"]);
    expect(items.some((c) => "security" in c)).toBe(false);
  });

  it("Cancel leaves channels untouched; no confirm when nothing is custom", () => {
    const { bridge } = open("settings");
    fireEvent.click(screen.getByText("Apply to all channels"));
    fireEvent.click(screen.getByText("Cancel"));
    expect(lastSet(bridge, "channels.yaml")).toBeUndefined();
    cleanup();
    const plain = open("settings", reply({ channels: [{ id: "c1", type: "ollama", enabled: true }] }));
    fireEvent.click(screen.getByText("Apply to all channels"));
    expect(screen.queryByText(/custom settings/)).toBeNull();
    expect(lastSet(plain.bridge, "channels.yaml")!.items).toHaveLength(1);
  });

  it("keeps the other settings fields when saving the form", () => {
    const { bridge } = open("settings");
    fireEvent.click(screen.getByText("Save settings"));
    expect(lastSet(bridge, "settings.yaml")!.security).toEqual({ passwords: true, privacy: true });
  });

  it("singular wording for one custom channel", () => {
    open("settings", reply({ channels: [{ id: "c2", type: "ollama", enabled: true, security: { privacy: false } }] }));
    fireEvent.click(screen.getByText("Apply to all channels"));
    expect(screen.getByText(/1 channel has custom settings/)).toBeTruthy();
  });
});

describe("channel editor security", () => {
  const card = (id: string) => screen.getByText(id, { selector: "b" }).closest(".card") as HTMLElement;

  it("shows the global default inside the Inherit option and the custom value as selected", () => {
    open("channels");
    const c1sel = within(card("c1")).getAllByRole("combobox") as HTMLSelectElement[];
    expect(c1sel.map((s) => s.value)).toEqual(["inherit", "inherit"]);
    expect(within(card("c1")).getAllByText("Inherit (on)")).toHaveLength(2);
    const c2sel = within(card("c2")).getAllByRole("combobox") as HTMLSelectElement[];
    expect(c2sel.map((s) => s.value)).toEqual(["off", "inherit"]);
    expect(within(card("c2")).getByText("Reset")).toBeTruthy();
  });

  it("shows Inherit (off) when the global default is off", () => {
    open("channels", reply({ settings: { runTurnLimit: 60, security: { passwords: true, privacy: false } } }));
    expect(within(card("c1")).getByText("Inherit (off)")).toBeTruthy();
  });

  it("marks disabled channels and shows a distinct name in the title", () => {
    open("channels", reply({ channels: [{ id: "c1", name: "Mine", type: "ollama", enabled: false }] }));
    expect(within(card("c1")).getByText("disabled")).toBeTruthy();
    expect(within(card("c1")).getByText("Mine")).toBeTruthy();
  });

  it("changing a rule saves only that channel's override", () => {
    const { bridge } = open("channels");
    const sel = within(card("c1")).getByText("Privacy", { selector: "span" }).parentElement!.querySelector("select")!;
    expect(sel.value).toBe("inherit");
    fireEvent.change(sel, { target: { value: "off" } });
    const items = lastSet(bridge, "channels.yaml")!.items as any[];
    expect(items[0].security).toEqual({ privacy: false });
    expect(items[1].security).toEqual({ passwords: false });
  });

  it("Reset removes the override and the empty security block", () => {
    const { bridge } = open("channels");
    fireEvent.click(within(card("c2")).getByText("Reset"));
    const items = lastSet(bridge, "channels.yaml")!.items as any[];
    expect(items[1]).not.toHaveProperty("security");
  });

  it("shows the Claude CLI hint on claude-cli channels only", () => {
    open("channels");
    expect(within(card("c2")).getByText(/read files themselves/)).toBeTruthy();
    expect(within(card("c1")).queryByText(/read files themselves/)).toBeNull();
  });
});

describe("policy.notice", () => {
  it("renders as an activity row without message text", () => {
    const { bridge, store } = mk();
    act(() => {
      bridge.inbound({ type: "event", ev: { kind: "run.started", runId: "r1", title: "x" } as never });
      bridge.inbound({ type: "event", ev: { kind: "text_delta", runId: "r1", seq: 0, text: "a" } as never });
      bridge.inbound({ type: "event", ev: { kind: "policy.notice", runId: "r1", roleId: "lead", channel: "c1", rule: "passwords", action: "withheld", where: "tool", msgIndex: 4 } as never });
      bridge.inbound({ type: "event", ev: { kind: "policy.notice", runId: "r1", roleId: "lead", channel: "cli", rule: "privacy", action: "refused", where: "system", msgIndex: 0 } as never });
    });
    const acts = store.state.items[store.state.items.length - 1].activity;
    expect(acts).toContainEqual({ kind: "policy", text: "business policy withheld a tool result on c1: passwords (tool #4)" });
    expect(acts).toContainEqual({ kind: "policy", text: "business policy refused to start on cli: privacy" });
    expect(activityIcon({ kind: "policy" })).toBe("🛡");
  });
});
