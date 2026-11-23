import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/preact";
import { removalImpact } from "../src/removalImpact.js";
import { ItemsSection } from "../src/items.js";
import { Store } from "../src/state.js";
import { MockBridge } from "../src/bridge.js";
import type { AgentSummary, ChannelSummary, RoleSummary } from "../src/bridge.js";

afterEach(cleanup);

const agents: AgentSummary[] = [
  { id: "a1", channel: "c1", model: "m" },
  { id: "a2", channel: "c2", model: "m" },
];
const roles: RoleSummary[] = [
  { id: "lead", enabled: true, agent: "a2", secondary: "a1" },
  { id: "helper", enabled: true, agent: "a1" },
  { id: "free", enabled: true },
];

describe("removalImpact", () => {
  it("a channel lists its agents and every role bound to them", () => {
    expect(removalImpact("channel", "c2", agents, roles)).toEqual({ agents: ["a2"], roles: ["lead"] });
    expect(removalImpact("channel", "c1", agents, roles)).toEqual({ agents: ["a1"], roles: ["lead", "helper"] });
  });

  it("an agent lists only the roles bound to it", () => {
    expect(removalImpact("agent", "a2", agents, roles)).toEqual({ agents: ["a2"], roles: ["lead"] });
    expect(removalImpact("agent", "a1", agents, roles).roles.sort()).toEqual(["helper", "lead"]);
  });
});

describe("ItemsSection remove confirm", () => {
  const fields = [{ key: "id", label: "id" }];
  const channel = (id: string): ChannelSummary => ({ id, type: "ollama", enabled: true });

  it("channel Remove shows the inline confirm; Cancel posts nothing; Confirm posts config.set", () => {
    const bridge = new MockBridge();
    const store = new Store(bridge);
    render(
      <ItemsSection<ChannelSummary>
        title="Channels" file="channels.yaml" items={[channel("c2")]} fields={fields} store={store}
        empty={channel("x")} confirmRemove={() => "Remove channel 'c2'? removes 1 agent (a2); resets roles: lead."}
      />,
    );
    fireEvent.click(screen.getByText("Remove"));
    expect(screen.getByText("Confirm remove")).toBeTruthy();
    expect(screen.getByText("Remove channel 'c2'? removes 1 agent (a2); resets roles: lead.")).toBeTruthy();
    fireEvent.click(screen.getByText("Cancel"));
    expect(bridge.sent.filter((m) => m.type === "config.set")).toEqual([]);
    fireEvent.click(screen.getByText("Remove"));
    fireEvent.click(screen.getByText("Confirm remove"));
    const msg = bridge.sent.find((m) => m.type === "config.set");
    expect(msg && msg.type === "config.set" && msg.file).toBe("channels.yaml");
    expect(msg && msg.type === "config.set" && msg.yaml).not.toContain("c2");
  });

  it("a bound agent confirms naming its roles; an unbound one removes at once", () => {
    const bridge = new MockBridge();
    const store = new Store(bridge);
    const confirm = (a: AgentSummary) => {
      const hit = removalImpact("agent", a.id, agents, roles);
      return hit.roles.length ? `Remove agent '${a.id}'? Resets roles: ${hit.roles.join(", ")}.` : undefined;
    };
    render(
      <ItemsSection<AgentSummary>
        title="Agents" file="agents.yaml" items={agents} fields={fields} store={store}
        empty={{ id: "x", channel: "c1", model: "" }} confirmRemove={confirm}
      />,
    );
    // a1 is bound to lead+helper → two-step confirm naming both.
    fireEvent.click(screen.getAllByText("Remove")[0]!);
    expect(screen.getByText("Remove agent 'a1'? Resets roles: lead, helper.")).toBeTruthy();
    fireEvent.click(screen.getByText("Cancel"));
    expect(bridge.sent.filter((m) => m.type === "config.set")).toEqual([]);
    // Re-render: a2 unbound? It is bound to lead — use an item with no role binding instead.
    cleanup();
    const solo: AgentSummary = { id: "a9", channel: "c2", model: "m" };
    render(
      <ItemsSection<AgentSummary>
        title="Agents" file="agents.yaml" items={[solo]} fields={fields} store={store}
        empty={{ id: "x", channel: "c1", model: "" }} confirmRemove={confirm}
      />,
    );
    fireEvent.click(screen.getByText("Remove")); // no confirm — unbound
    expect(bridge.sent.find((m) => m.type === "config.set")).toBeTruthy();
  });
});
