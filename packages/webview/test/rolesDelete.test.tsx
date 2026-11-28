import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/preact";
import { RolesSection, activeLeadId } from "../src/rolesSection.js";
import { Store } from "../src/state.js";
import { MockBridge } from "../src/bridge.js";
import type { AgentSummary, RoleSummary } from "../src/bridge.js";

afterEach(cleanup);

const agents: AgentSummary[] = [{ id: "a1", channel: "c1", model: "m" }];

function renderSection(roles: RoleSummary[]) {
  const bridge = new MockBridge();
  const store = new Store(bridge);
  render(<RolesSection store={store} roles={roles} agents={agents} channels={[]} skills={[]} />);
  return { bridge };
}

const writes = (bridge: MockBridge) => bridge.sent.filter((m) => m.type === "config.set") as { file: string; yaml: string }[];

describe("activeLeadId", () => {
  it("mirrors the core resolution order", () => {
    expect(activeLeadId([{ id: "lead", enabled: true }, { id: "w", enabled: true }])).toBe("lead");
    expect(activeLeadId([{ id: "lead", enabled: false }, { id: "w", enabled: true }])).toBe("w");
    expect(activeLeadId([{ id: "w", enabled: true }, { id: "lead", enabled: false }])).toBe("w");
    expect(activeLeadId([{ id: "lead", enabled: false }, { id: "f", enabled: true, kind: "function" }])).toBe(undefined);
    expect(activeLeadId([])).toBe(undefined);
  });
});

describe("role delete", () => {
  const roles: RoleSummary[] = [
    { id: "lead", enabled: true, agent: "a1" },
    { id: "helper", enabled: true, agent: "a1" },
    { id: "off", enabled: false },
  ];

  it("every role card has a Delete button below Reset/Edit; cancel posts nothing", () => {
    const { bridge } = renderSection(roles);
    expect(screen.getAllByText("Delete")).toHaveLength(3);
    fireEvent.click(screen.getAllByText("Delete")[2]);
    expect(screen.getByText(/Delete role off\?/)).toBeTruthy();
    fireEvent.click(screen.getByText("Cancel"));
    expect(writes(bridge)).toEqual([]);
    expect(screen.queryByText(/Delete role off\?/)).toBeNull();
  });

  it("confirm removes the row from the saved roles.yaml", () => {
    const { bridge } = renderSection(roles);
    fireEvent.click(screen.getAllByText("Delete")[2]);
    fireEvent.click(screen.getByText("Confirm delete"));
    const w = writes(bridge);
    expect(w).toHaveLength(1);
    expect(w[0].file).toBe("roles.yaml");
    expect(w[0].yaml).not.toContain("off");
    expect(w[0].yaml).toContain("lead");
  });

  it("deleting the active lead names the fallback in the confirm copy", () => {
    renderSection(roles);
    fireEvent.click(screen.getAllByText("Delete")[0]);
    expect(screen.getByText(/helper becomes the active lead instead/)).toBeTruthy();
  });

  it("deleting the only enabled agent-kind role warns chat will be unavailable", () => {
    renderSection([{ id: "lead", enabled: true, agent: "a1" }, { id: "off", enabled: false }]);
    fireEvent.click(screen.getAllByText("Delete")[0]);
    expect(screen.getByText(/chat will be unavailable/)).toBeTruthy();
  });

  it("an enabled non-lead role is marked enabled without a fallback claim", () => {
    renderSection(roles);
    fireEvent.click(screen.getAllByText("Delete")[1]);
    expect(screen.getByText(/This role is enabled\./)).toBeTruthy();
    expect(screen.queryByText(/active lead/)).toBeNull();
  });
});
