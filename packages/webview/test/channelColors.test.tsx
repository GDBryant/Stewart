import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, fireEvent, act } from "@testing-library/preact";
import { App } from "../src/App.js";
import { Store } from "../src/state.js";
import { MockBridge, type ConfigReply } from "../src/bridge.js";
import { CHANNEL_PALETTE, channelColor } from "../src/channelColors.js";
import { ReviewStep } from "../src/SetupWizardResult.js";

afterEach(cleanup);

const noop = () => {};

/** jsdom serializes inline colours either as the original hex or as rgb(r, g, b); normalize to hex. */
function styleHex(el: Element | null | undefined): string {
  const s = el?.getAttribute("style") ?? "";
  const m = s.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  if (!m) return s.replace(/\s+/g, "").toLowerCase();
  const hex = m.slice(1, 4).map((n) => Number(n).toString(16).padStart(2, "0")).join("");
  return `#${hex}`;
}

describe("channelColor", () => {
  it("maps a channel id to a palette colour deterministically", () => {
    expect(CHANNEL_PALETTE).toContain(channelColor("c1"));
    expect(channelColor("c1")).toBe(channelColor("c1"));
  });

  it("spreads different channel ids across the palette", () => {
    const ids = ["c1", "c2", "c3", "ollama", "local-ollama", "openai", "openrouter", "lmstudio", "claude", "custom", "aif"];
    expect(new Set(ids.map(channelColor)).size).toBeGreaterThanOrEqual(4);
  });

  it("still returns a palette colour for empty or unusual ids", () => {
    for (const id of ["", " ", "channel with spaces", "🙂"]) expect(CHANNEL_PALETTE).toContain(channelColor(id));
  });
});

describe("channel colour badges", () => {
  const configReply: { type: "config" } & ConfigReply = {
    type: "config" as const,
    files: { "channels.yaml": "version: 1\nitems: []\n" },
    summary: {
      channels: [
        { id: "c1", type: "ollama", enabled: true, baseUrl: "http://x" },
        { id: "c2", type: "openai-compatible", enabled: true, baseUrl: "http://y", modelCaps: { v: { vision: true } } },
      ],
      agents: [
        { id: "a1", channel: "c1", model: "m", effort: "medium" },
        { id: "va", channel: "c2", model: "v", effort: "medium" },
      ],
      roles: [
        { id: "general-worker", enabled: true, agent: "a1", skills: ["execution-contract"], tools: ["WriteFile"] },
        { id: "image-reader", enabled: false },
      ],
      skills: [
        { id: "execution-contract", description: "contract", body: "BODY", version: 1, source: "shipped", edited: false, updateAvailable: false },
      ],
      settings: {},
    },
    errors: [],
  };

  function mk() {
    const bridge = new MockBridge();
    const store = new Store(bridge);
    render(<App store={store} />);
    return bridge;
  }

  const roleCard = (id: string) => screen.getByText(id).closest(".card")!;

  it("badges each channel card with its colour on the channels tab", () => {
    const bridge = mk();
    fireEvent.click(screen.getAllByText("Settings")[0]);
    act(() => bridge.inbound(configReply));
    expect(styleHex(roleCard("c1").querySelector(".ch-dot"))).toBe(channelColor("c1"));
    expect(styleHex(roleCard("c2").querySelector(".ch-dot"))).toBe(channelColor("c2"));
  });

  it("badges channels in the setup wizard's channel step", () => {
    const bridge = mk();
    fireEvent.click(screen.getAllByText("Settings")[0]);
    act(() => bridge.inbound(configReply));
    fireEvent.click(screen.getByText("Run setup"));
    fireEvent.click(screen.getByText("Start"));
    const dots = document.querySelectorAll(".summary .ch-dot");
    expect(dots.length).toBe(2);
    expect(styleHex(dots[0])).toBe(channelColor("c1"));
    expect(styleHex(dots[1])).toBe(channelColor("c2"));
  });
  it("badges each role card with its agent's channel colour and shows the agent name in a second row", () => {
    const bridge = mk();
    fireEvent.click(screen.getAllByText("Settings")[0]);
    act(() => bridge.inbound(configReply));
    fireEvent.click(screen.getByText("roles"));
    const card = roleCard("general-worker");
    expect(styleHex(card.querySelector(".ch-dot"))).toBe(channelColor("c1"));
    expect(card.querySelector(".role-agent")!.textContent).toBe("agent: a1");
  });

  it("updates the colour badge and agent name when the role's agent changes", () => {
    const bridge = mk();
    fireEvent.click(screen.getAllByText("Settings")[0]);
    act(() => bridge.inbound(configReply));
    fireEvent.click(screen.getByText("roles"));
    const card = roleCard("general-worker");
    expect(styleHex(card.querySelector(".ch-dot"))).toBe(channelColor("c1"));
    fireEvent.click(screen.getAllByText("Edit")[0]);
    const agentSelect = card.querySelectorAll("select")[0];
    fireEvent.change(agentSelect, { target: { value: "va" } });
    const set = bridge.sent.find((m) => m.type === "config.set") as { file: string; yaml: string } | undefined;
    expect(set?.file).toBe("roles.yaml");
    expect(set?.yaml).toContain("agent: va");
    act(() =>
      bridge.inbound({
        ...configReply,
        summary: {
          ...configReply.summary,
          roles: [{ ...configReply.summary.roles[0], agent: "va" }, configReply.summary.roles[1]],
        },
      }),
    );
    const updated = roleCard("general-worker");
    expect(styleHex(updated.querySelector(".ch-dot"))).toBe(channelColor("c2"));
    expect(updated.querySelector(".role-agent")!.textContent).toBe("agent: va");
  });

  it("shows no colour badge and 'no agent' for a role without an agent", () => {
    const bridge = mk();
    fireEvent.click(screen.getAllByText("Settings")[0]);
    act(() => bridge.inbound(configReply));
    fireEvent.click(screen.getByText("roles"));
    const card = roleCard("image-reader");
    expect(card.querySelector(".ch-dot")).toBeNull();
    expect(card.querySelector(".role-agent")!.textContent).toBe("no agent");
  });

  it("shows no colour badge when the assigned agent no longer exists", () => {
    const bridge = mk();
    fireEvent.click(screen.getAllByText("Settings")[0]);
    act(() =>
      bridge.inbound({
        ...configReply,
        summary: { ...configReply.summary, roles: [{ ...configReply.summary.roles[0], agent: "gone" }, configReply.summary.roles[1]] },
      }),
    );
    fireEvent.click(screen.getByText("roles"));
    const card = roleCard("general-worker");
    expect(card.querySelector(".ch-dot")).toBeNull();
    expect(card.querySelector(".role-agent")!.textContent).toBe("agent: gone");
  });
});

describe("review step channel colour", () => {
  const reviewProps = (rowFor: (roleId: string) => string) => ({
    rec: { assignments: [{ role: "general-worker", channel: "c1", model: "m" }], unfilled: [] },
    recommendBusy: false,
    recommendError: undefined,
    evalMode: "rules" as const,
    bench: false,
    roles: [{ id: "general-worker", enabled: true }] as never,
    eligiblePairs: [{ channel: "c1", model: "m" }],
    rowFor,
    edits: {},
    probeResults: {},
    onEditRole: noop,
    onApply: noop,
    onBack: noop,
    onUseRules: noop,
  });

  it("colour-codes each review row by its selected channel", () => {
    render(<ReviewStep {...reviewProps((id) => (id === "general-worker" ? "c1:big:32b" : ""))} />);
    const dot = document.querySelector(".summary .ch-dot");
    expect(styleHex(dot)).toBe(channelColor("c1"));
  });

  it("omits the colour dot when no channel is selected", () => {
    render(<ReviewStep {...reviewProps(() => "")} />);
    expect(document.querySelector(".summary .ch-dot")).toBeNull();
  });
});
