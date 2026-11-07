import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { cleanup } from "@testing-library/preact";
import { render, screen, fireEvent, act } from "@testing-library/preact";
import { App } from "../src/App.js";
import { Store } from "../src/state.js";
import { MockBridge, agentCosts, type ConfigReply } from "../src/bridge.js";
import { modelsForChannel } from "../src/SettingsView.js";

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
    expect(bridge.sent).toContainEqual(expect.objectContaining({ type: "chat.send", text: "hello" }));

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

  it("records compaction savings as an activity line", () => {
    const { bridge, store } = mk();
    act(() => {
      bridge.inbound(ev("run.started", { title: "x" }));
      bridge.inbound(ev("compaction", { droppedTokens: 300, pruned: 2, summarized: true }));
      bridge.inbound(ev("compaction", { droppedTokens: 10 }));
    });
    const texts = JSON.stringify(store.state);
    expect(texts).toContain("context compacted: -300 tokens, 2 pruned, summarized");
    expect(texts).toContain("context compacted: -10 tokens\"");
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

  it("renders orchestration tasks with their live status", () => {
    const { bridge } = mk();
    act(() => {
      bridge.inbound(ev("run.started", { title: "x" }));
      bridge.inbound(ev("task.created", { taskId: "t1", roleId: "code-writer", title: "write a.ts", dependsOn: [] }));
      bridge.inbound(ev("task.created", { taskId: "t2", roleId: "tester", title: "run tests", dependsOn: ["t1"] }));
      bridge.inbound(ev("task.started", { taskId: "t1", roleId: "code-writer" }));
    });
    expect(screen.getAllByText("write a.ts").length).toBeGreaterThan(0);
    expect(screen.getByText("running")).toBeTruthy();
    expect(screen.getByText("pending")).toBeTruthy();
    act(() => {
      bridge.inbound(ev("task.done", { taskId: "t1", roleId: "code-writer", summary: "wrote it" }));
      bridge.inbound(ev("task.blocked", { taskId: "t2", roleId: "tester", waitingOn: "t1" }));
      bridge.inbound(ev("task.failed", { taskId: "t2", roleId: "tester", error: "tests failed" }));
    });
    expect(screen.getByText("done")).toBeTruthy();
    expect(screen.getByText("tests failed")).toBeTruthy();
  });

  it("lists running tasks with role, agent and a ticking timer, and hides finished ones", () => {
    vi.useFakeTimers();
    try {
      const { bridge } = mk();
      act(() => {
        bridge.inbound(ev("run.started", { title: "x" }));
        bridge.inbound(ev("task.created", { taskId: "t1", roleId: "code-writer", title: "write a.ts", dependsOn: [] }));
        bridge.inbound(ev("task.started", { taskId: "t1", roleId: "code-writer", agentId: "qwen-local" }));
      });
      expect(screen.getByText("Active")).toBeTruthy();
      expect(screen.getByText("qwen-local")).toBeTruthy();
      expect(screen.getByText("0:00")).toBeTruthy();
      act(() => {
        vi.advanceTimersByTime(65_000);
      });
      expect(screen.getByText("1:05")).toBeTruthy();
      act(() => {
        bridge.inbound(ev("task.done", { taskId: "t1", roleId: "code-writer", summary: "ok" }));
      });
      expect(screen.queryByText("Active")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("hides the task rows for a single direct task but keeps them for orchestrated runs", () => {
    const { bridge } = mk();
    act(() => {
      bridge.inbound(ev("run.started", { title: "x" }));
      bridge.inbound(ev("task.created", { taskId: "direct", roleId: "chat", title: "only-direct-title", dependsOn: [] }));
    });
    expect(screen.queryByText("only-direct-title")).toBeNull();
    expect(screen.queryByText("Tasks")).toBeNull();
    act(() => bridge.inbound(ev("task.created", { taskId: "t1", roleId: "general-worker", title: "second-task", dependsOn: [] })));
    expect(screen.getByText("Tasks")).toBeTruthy();
    expect(screen.getByText("second-task")).toBeTruthy();
  });

  it("shows the plan state and its validator verdict", () => {
    const { bridge } = mk();
    act(() => {
      bridge.inbound(ev("run.started", { title: "x" }));
      bridge.inbound(ev("plan.created", { milestoneCount: 3 }));
      bridge.inbound(ev("plan.validated", { verdict: "revise", reasons: ["missing tests"] }));
    });
    expect(screen.getByText("3 milestone(s)")).toBeTruthy();
    expect(screen.getByText("revise")).toBeTruthy();
    expect(screen.getByText("missing tests")).toBeTruthy();
    act(() => bridge.inbound(ev("plan.approved", { milestoneCount: 3 })));
    expect(screen.getByText("approved")).toBeTruthy();
  });

  it("renders the cost panel with parked work and suggestions", () => {
    const { bridge } = mk();
    act(() => {
      bridge.inbound(ev("run.started", { title: "x" }));
      bridge.inbound(
        ev("cost.summary", {
          capUsd: 1,
          accruedUsd: 1.25,
          overshootUsd: 0.25,
          byRole: { "code-writer": 1.25 },
          byAgent: { "a-paid": { costUsd: 1.25, inTokens: 10, outTokens: 5 } },
          parked: ["write b.ts"],
          freeFinished: ["look"],
          suggestions: [{ role: "code-writer", agent: "free-big", reason: "free" }],
        }),
      );
    });
    expect(screen.getByText("$1.25 of $1.00")).toBeTruthy();
    expect(screen.getByText("overshoot $0.25")).toBeTruthy();
    expect(screen.getByText("parked: write b.ts")).toBeTruthy();
    expect(screen.getByText("finished free: look")).toBeTruthy();
    expect(screen.getByText(/suggest code-writer → free-big/)).toBeTruthy();
  });

  it("raises the displayed cap when the cost limit is raised", () => {
    const { bridge } = mk();
    act(() => {
      bridge.inbound(ev("run.started", { title: "x" }));
      bridge.inbound(ev("cost.limit_reached", { capUsd: 1, accruedUsd: 1.1 }));
      bridge.inbound(ev("cost.limit_raised", { capUsd: 2 }));
    });
    expect(screen.getByText("$1.10 of $2.00")).toBeTruthy();
  });

  it("clears tasks, plan and cost when a new run starts", () => {
    const { bridge, store } = mk();
    act(() => {
      bridge.inbound(ev("run.started", { title: "x" }));
      bridge.inbound(ev("task.created", { taskId: "t1", roleId: "code-writer", title: "write", dependsOn: [] }));
      bridge.inbound(ev("plan.created", { milestoneCount: 1 }));
      bridge.inbound(ev("cost.limit_reached", { capUsd: 1, accruedUsd: 0.5 }));
      bridge.inbound(ev("run.finished", { status: "done" }));
      bridge.inbound({ type: "event", ev: { kind: "run.started", runId: "r2", title: "y" } as never });
    });
    expect(store.state.tasks).toHaveLength(0);
    expect(store.state.plan).toBeUndefined();
    expect(store.state.cost).toBeUndefined();
  });

  it("marks failed runs in the transcript", () => {
    const { bridge } = mk();
    act(() => {
      bridge.inbound(ev("run.started", { title: "x" }));
      bridge.inbound(ev("run.finished", { status: "failed", error: "boom" }));
    });
    expect(screen.getByText("boom")).toBeTruthy();
  });

  it("shows Revert run changes after a run finishes and hides it once reverted", () => {
    const { bridge } = mk();
    act(() => {
      bridge.inbound(ev("run.started", { title: "x" }));
      bridge.inbound(ev("run.finished", { status: "done" }));
    });
    const btn = screen.getByText("Revert run changes");
    fireEvent.click(btn);
    expect(bridge.sent).toContainEqual({ type: "chat.revert", runId: "r1" });
    act(() => {
      bridge.inbound(ev("run.reverted", { filesRestored: ["a.ts", "b.ts"] }));
    });
    expect(screen.getByText("Reverted: a.ts, b.ts")).toBeTruthy();
    expect(screen.queryByText("Revert run changes")).toBeNull();
  });
});

describe("webview history", () => {
  const sessions = [{ sessionId: "s1", title: "old chat", savedAt: 1000, messageCount: 3 }];

  it("lists sessions, loads one into the transcript and deletes it", async () => {
    const { bridge, store } = mk();
    fireEvent.click(screen.getByText("History"));
    expect(bridge.sent).toContainEqual({ type: "history.list" });
    act(() => bridge.inbound({ type: "history.sessions", sessions }));
    expect(screen.getByText("old chat")).toBeTruthy();

    fireEvent.click(screen.getByTitle("s1"));
    expect(bridge.sent).toContainEqual({ type: "history.load", sessionId: "s1" });
    act(() =>
      bridge.inbound({
        type: "history.messages",
        sessionId: "s1",
        messages: [
          { role: "user", content: "earlier" },
          { role: "assistant", content: "reply", toolCalls: [{ id: "c1", name: "ReadFile", arguments: {} }] },
          { role: "tool", content: "read a.ts" },
        ],
      }),
    );
    expect(screen.getByText("earlier")).toBeTruthy();
    expect(screen.getByText("reply")).toBeTruthy();
    expect(screen.getByText(/read a\.ts/)).toBeTruthy();
    expect(store.state.sessionId).toBe("s1");
    expect(store.state.historyOpen).toBe(false);

    fireEvent.click(screen.getByText("History"));
    act(() => bridge.inbound({ type: "history.sessions", sessions }));
    fireEvent.click(screen.getByText("Delete"));
    expect(bridge.sent).toContainEqual({ type: "history.delete", sessionId: "s1" });
    expect(bridge.sent.filter((m) => m.type === "history.list").length).toBeGreaterThanOrEqual(2);
    expect(store.state.sessionId).toBeUndefined();
  });
});

describe("webview images", () => {
  const pngFile = (size = 4) => new File([new Uint8Array(size)], "a.png", { type: "image/png" });
  const picker = () => document.querySelector('input[type="file"]') as HTMLInputElement;
  const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 10)); });

  it("attaches a valid image via the picker and sends it with the message", async () => {
    const { bridge, store } = mk();
    fireEvent.change(picker(), { target: { files: [pngFile()] } });
    await flush();
    expect(store.state.pendingImages).toHaveLength(1);
    expect(document.querySelector(".pending-img")).toBeTruthy();

    fireEvent.click(screen.getByText("Send"));
    const msg = bridge.sent.find((m) => m.type === "chat.send");
    expect(msg && msg.type === "chat.send" && msg.images?.[0]).toMatch(/^data:image\/png;base64,/);
    expect(store.state.pendingImages).toHaveLength(0);
  });

  it("rejects a non-image file", async () => {
    const { store } = mk();
    fireEvent.change(picker(), { target: { files: [new File(["x"], "a.txt", { type: "text/plain" })] } });
    await flush();
    expect(store.state.pendingImages).toHaveLength(0);
    expect(screen.getByText(/only PNG, JPEG, GIF and WebP/)).toBeTruthy();
  });

  it("rejects an oversized image and caps at five attachments", async () => {
    const { store } = mk();
    act(() => store.addImage(`data:image/png;base64,${"A".repeat(7_000_000)}`));
    expect(store.state.pendingImages).toHaveLength(0);
    expect(screen.getByText(/exceeds the 5 MB limit/)).toBeTruthy();
    for (let i = 0; i < 6; i++) act(() => store.addImage("data:image/png;base64,aGk="));
    expect(store.state.pendingImages).toHaveLength(5);
    expect(screen.getByText(/at most 5 images/)).toBeTruthy();
    act(() => store.removeImage(0));
    expect(store.state.pendingImages).toHaveLength(4);
  });
});

describe("webview editor insert", () => {
  it("posts editor.insert from an assistant message", () => {
    const { bridge } = mk();
    act(() => {
      bridge.inbound(ev("run.started", { title: "x" }));
      bridge.inbound(ev("text_delta", { seq: 0, text: "use this" }));
      bridge.inbound(ev("run.finished", { status: "done" }));
    });
    fireEvent.click(screen.getByText("Insert into editor"));
    expect(bridge.sent).toContainEqual({ type: "editor.insert", text: "use this" });
  });

  it("fills the composer from an insertText inbound message", () => {
    const { bridge } = mk();
    act(() => bridge.inbound({ type: "insertText", text: "selected code" }));
    expect((screen.getByPlaceholderText("Ask Stewart") as HTMLTextAreaElement).value).toBe("selected code");
  });
});

describe("webview settings", () => {
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
        { id: "tdd", description: "tests first", body: "TDD BODY", version: 1, source: "user", edited: true, updateAvailable: true },
      ],
      settings: { costLimit: { perRunUsd: 5, onLimit: "ask" } },
    },
    errors: [],
  };

  it("renders channels from config reply and edits + saves a field", async () => {
    const { bridge } = mk();
    fireEvent.click(screen.getAllByText("Settings")[0]);
    act(() => bridge.inbound(configReply));
    expect(screen.getByText("c1")).toBeTruthy();
    fireEvent.click(screen.getAllByText("Edit")[0]);
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
    fireEvent.click(screen.getAllByText("Test")[0]);
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

  const openRoles = (bridge: MockBridge) => {
    fireEvent.click(screen.getAllByText("Settings")[0]);
    act(() => bridge.inbound(configReply));
    fireEvent.click(screen.getByText("roles"));
  };

  it("ticks a role on and saves roles.yaml", () => {
    const { bridge } = mk();
    openRoles(bridge);
    const box = screen.getByText("image-reader").parentElement!.querySelector("input")!;
    expect(box.checked).toBe(false);
    fireEvent.click(box);
    const set = bridge.sent.find((m) => m.type === "config.set");
    expect(set && set.type === "config.set" && set.file).toBe("roles.yaml");
    expect(set && set.type === "config.set" && set.yaml).toContain("enabled: true");
    expect(set && set.type === "config.set" && set.yaml).toContain("image-reader");
  });

  it("filters the role agent dropdown by required capability", () => {
    const { bridge } = mk();
    openRoles(bridge);
    fireEvent.click(screen.getAllByText("Edit")[1]);
    const selects = document.querySelectorAll("select");
    const opts = [...selects[selects.length - 2].options].map((o) => o.value);
    expect(opts).toContain("va");
    expect(opts).not.toContain("a1");
  });

  it("resets a role and all roles", () => {
    const { bridge } = mk();
    openRoles(bridge);
    fireEvent.click(screen.getAllByText("Reset")[0]);
    expect(bridge.sent).toContainEqual({ type: "roles.reset", roleId: "general-worker" });
    fireEvent.click(screen.getByText("Reset all"));
    expect(bridge.sent).toContainEqual({ type: "roles.reset", roleId: undefined });
  });

  it("assigns one agent to all roles", () => {
    const { bridge } = mk();
    openRoles(bridge);
    const picker = screen.getByText("assign agent…").parentElement as HTMLSelectElement;
    fireEvent.change(picker, { target: { value: "a1" } });
    fireEvent.click(screen.getByText("Assign to all"));
    expect(bridge.sent).toContainEqual({ type: "roles.assignAgent", agentId: "a1" });
  });

  const openSkills = (bridge: MockBridge) => {
    fireEvent.click(screen.getAllByText("Settings")[0]);
    act(() => bridge.inbound(configReply));
    fireEvent.click(screen.getByText("skills"));
  };

  it("opens a skill file in the editor", () => {
    const { bridge } = mk();
    openSkills(bridge);
    fireEvent.click(screen.getAllByText("Open file")[1]);
    expect(bridge.sent).toContainEqual({ type: "skills.open", id: "tdd" });
  });

  it("saves an edited skill body and resets a user skill", () => {
    const { bridge } = mk();
    openSkills(bridge);
    fireEvent.click(screen.getAllByText("Edit")[1]);
    const area = document.querySelector("textarea")!;
    fireEvent.input(area, { target: { value: "new body" } });
    fireEvent.click(screen.getByText("Save"));
    expect(bridge.sent).toContainEqual({ type: "skills.save", id: "tdd", body: "new body", description: "tests first" });
    fireEvent.click(screen.getAllByText("Reset")[0]);
    expect(bridge.sent).toContainEqual({ type: "skills.reset", id: "tdd" });
  });

  it("creates a new skill and rejects a duplicate id", () => {
    const { bridge } = mk();
    openSkills(bridge);
    fireEvent.click(screen.getByText("+ New"));
    fireEvent.input(screen.getByPlaceholderText("my-skill"), { target: { value: "my skill" } });
    fireEvent.click(screen.getByText("Create"));
    expect(bridge.sent).toContainEqual({ type: "skills.save", id: "my-skill", body: "", description: "" });

    fireEvent.click(screen.getByText("+ New"));
    fireEvent.input(screen.getByPlaceholderText("my-skill"), { target: { value: "tdd" } });
    expect(screen.getByText(/already exists/)).toBeTruthy();
    expect((screen.getByText("Create") as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows unmetered and capability badges on agents and triggers model probe", () => {
    const { bridge } = mk();
    fireEvent.click(screen.getAllByText("Settings")[0]);
    act(() => bridge.inbound(configReply));
    fireEvent.click(screen.getByText("agents"));
    expect(screen.getByText("unmetered")).toBeTruthy();
    expect(screen.getByText("vision")).toBeTruthy();
    fireEvent.click(screen.getAllByText("Probe")[0]);
    expect(bridge.sent).toContainEqual({ type: "channel.probe", channelId: "c1", model: "m", force: true });
    act(() => {
      bridge.inbound({
        type: "channel.probe.result",
        channelId: "c1",
        model: "m",
        ok: true,
        caps: { tools: "native", contextTokens: 64000 },
        probedAt: 123,
      });
    });
    expect(screen.getByText("tools:native")).toBeTruthy();
    expect(screen.getByText("64k")).toBeTruthy();
    expect(screen.getByText("Re-probe")).toBeTruthy();
  });

  it("imports v1 settings through the draft card", () => {
    const { bridge, store } = mk();
    fireEvent.click(screen.getAllByText("Settings")[0]);
    act(() => bridge.inbound(configReply));
    fireEvent.click(screen.getByText("settings"));
    fireEvent.click(screen.getByText("Pick stewart.xml…"));
    expect(bridge.sent).toContainEqual({ type: "v1.import" });

    act(() =>
      bridge.inbound({
        type: "v1.draft",
        files: { "channels.yaml": "version: 1\nitems: []" },
        warnings: ["skipped secrets"],
        xml: "<stewart/>",
      }),
    );
    expect(screen.getByText(/skipped secrets/)).toBeTruthy();
    expect(screen.getByText(/produces: channels\.yaml/)).toBeTruthy();

    fireEvent.click(screen.getByText("Apply"));
    expect(bridge.sent).toContainEqual({ type: "config.importV1", xml: "<stewart/>", apply: true });
    act(() => bridge.inbound({ type: "v1.draft", files: {}, warnings: [], applied: true }));
    expect(store.state.v1Draft).toBeUndefined();
    fireEvent.click(screen.getAllByText("Chat")[0]);
    expect(screen.getByText("v1 settings imported.")).toBeTruthy();
  });

  it("+ Add opens a draft card and saves config.set only after an id is entered", () => {
    const { bridge } = mk();
    fireEvent.click(screen.getAllByText("Settings")[0]);
    act(() => bridge.inbound(configReply));
    const configGets = () => bridge.sent.filter((m) => m.type === "config.get").length;
    const getsBefore = configGets();
    fireEvent.click(screen.getByText("+ Add"));
    expect(bridge.sent.some((m) => m.type === "config.set")).toBe(false);
    const save = screen.getByText("Save") as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.input(document.querySelector(".form input")!, { target: { value: "channel-3" } });
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    const set = bridge.sent.find((m) => m.type === "config.set");
    expect(set && set.type === "config.set" && set.file).toBe("channels.yaml");
    expect(set && set.type === "config.set" && set.yaml).toContain("channel-3");
    expect(configGets()).toBe(getsBefore);
  });

  it("Remove on a saved channel sends config.set without it", () => {
    const { bridge } = mk();
    fireEvent.click(screen.getAllByText("Settings")[0]);
    act(() => bridge.inbound(configReply));
    fireEvent.click(screen.getAllByText("Remove")[0]);
    const set = bridge.sent.find((m) => m.type === "config.set" && m.file === "channels.yaml") as any;
    expect(set.yaml).not.toContain("id: c1");
    expect(set.yaml).toContain("id: c2");
  });

  it("Remove on an unsaved draft discards it without config.set", () => {
    const { bridge } = mk();
    fireEvent.click(screen.getAllByText("Settings")[0]);
    act(() => bridge.inbound(configReply));
    fireEvent.click(screen.getByText("+ Add"));
    const removes = screen.getAllByText("Remove").length;
    fireEvent.click(screen.getAllByText("Remove")[removes - 1]);
    expect(screen.getAllByText("Remove").length).toBe(removes - 1);
    expect(bridge.sent.some((m) => m.type === "config.set")).toBe(false);
  });

  describe("channel API key", () => {
    const withChannels = (channels: unknown[], secrets: Record<string, boolean>) =>
      ({ ...configReply, summary: { ...configReply.summary, channels }, secrets }) as typeof configReply;
    const KEY = "sk-live-0123456789abcdef";

    it("draft with an API key stores it via secret.set and writes only the ref to YAML", () => {
      const { bridge } = mk();
      fireEvent.click(screen.getAllByText("Settings")[0]);
      act(() => bridge.inbound(configReply));
      fireEvent.click(screen.getByText("+ Add"));
      const inputs = document.querySelectorAll(".form input");
      fireEvent.input(inputs[0], { target: { value: "aif" } });
      const keyInput = document.querySelector('.form input[type="password"]') as HTMLInputElement;
      fireEvent.input(keyInput, { target: { value: KEY } });
      fireEvent.click(screen.getByText("Save"));
      const secretIdx = bridge.sent.findIndex((m) => m.type === "secret.set");
      const setIdx = bridge.sent.findIndex((m) => m.type === "config.set");
      expect(bridge.sent[secretIdx]).toEqual({ type: "secret.set", ref: "channel-aif", value: KEY });
      expect(secretIdx).toBeLessThan(setIdx);
      const yaml = (bridge.sent[setIdx] as { yaml: string }).yaml;
      expect(yaml).toContain("secretRef: channel-aif");
      expect(yaml).not.toContain(KEY);
      expect(yaml).not.toContain("apiKey");
    });

    it("no secret.set when the key box is blank", () => {
      const { bridge } = mk();
      fireEvent.click(screen.getAllByText("Settings")[0]);
      act(() => bridge.inbound(configReply));
      fireEvent.click(screen.getByText("+ Add"));
      fireEvent.input(document.querySelectorAll(".form input")[0], { target: { value: "plain" } });
      fireEvent.click(screen.getByText("Save"));
      expect(bridge.sent.some((m) => m.type === "secret.set")).toBe(false);
      expect((bridge.sent.find((m) => m.type === "config.set") as { yaml: string }).yaml).not.toContain("secretRef");
    });

    it("cancelling an edit discards the typed key", () => {
      const { bridge } = mk();
      fireEvent.click(screen.getAllByText("Settings")[0]);
      act(() => bridge.inbound(configReply));
      fireEvent.click(screen.getAllByText("Edit")[0]);
      fireEvent.input(document.querySelector('.form input[type="password"]')!, { target: { value: KEY } });
      fireEvent.click(screen.getByText("Cancel"));
      fireEvent.click(screen.getAllByText("Edit")[0]);
      expect((document.querySelector('.form input[type="password"]') as HTMLInputElement).value).toBe("");
      expect(bridge.sent.some((m) => m.type === "secret.set")).toBe(false);
    });

    it("shows stored / not-stored status and Clear key only when stored", () => {
      const { bridge } = mk();
      fireEvent.click(screen.getAllByText("Settings")[0]);
      act(() =>
        bridge.inbound(
          withChannels(
            [
              { id: "a", type: "openai-compatible", enabled: true, secretRef: "channel-a" },
              { id: "b", type: "openai-compatible", enabled: true, secretRef: "channel-b" },
            ],
            { "channel-a": true, "channel-b": false },
          ),
        ),
      );
      expect(screen.getAllByText("key stored").length).toBe(1);
      expect(screen.getAllByText("no key stored").length).toBe(1);
      fireEvent.click(screen.getByText("Clear key"));
      expect(bridge.sent).toContainEqual({ type: "secret.delete", ref: "channel-a" });
    });

    it("warns about a pasted key in secretRef and moves it into the secret store", () => {
      const { bridge } = mk();
      fireEvent.click(screen.getAllByText("Settings")[0]);
      act(() => bridge.inbound(withChannels([{ id: "aif", type: "openai-compatible", enabled: true, secretRef: KEY }], { [KEY]: false })));
      expect(screen.getByText(/saved as plain text/)).toBeTruthy();
      expect(screen.queryByText("Clear key")).toBeNull();
      fireEvent.click(screen.getByText("Move to secret store"));
      expect(bridge.sent).toContainEqual({ type: "secret.set", ref: "channel-aif", value: KEY });
      const yaml = (bridge.sent.find((m) => m.type === "config.set") as { yaml: string }).yaml;
      expect(yaml).toContain("secretRef: channel-aif");
      expect(yaml).not.toContain(KEY);
    });

    it("does not warn for a normal ref name", () => {
      const { bridge } = mk();
      fireEvent.click(screen.getAllByText("Settings")[0]);
      act(() => bridge.inbound(withChannels([{ id: "a", type: "ollama", enabled: true, secretRef: "my-ref" }], { "my-ref": true })));
      expect(screen.queryByText(/saved as plain text/)).toBeNull();
    });
  });

  it("shows host errors in settings and clears them on the next config reply", () => {
    const { bridge, store } = mk();
    fireEvent.click(screen.getAllByText("Settings")[0]);
    act(() => bridge.inbound(configReply));
    act(() => bridge.inbound({ type: "error", message: "invalid channels.yaml: bad" }));
    expect(store.state.lastError).toBe("invalid channels.yaml: bad");
    expect(screen.getByText(/invalid channels\.yaml: bad/)).toBeTruthy();
    act(() => bridge.inbound(configReply));
    expect(store.state.lastError).toBeUndefined();
    expect(screen.queryByText(/invalid channels\.yaml: bad/)).toBeNull();
  });

  const openWizard = (bridge: MockBridge) => {
    fireEvent.click(screen.getAllByText("Settings")[0]);
    act(() => bridge.inbound(configReply));
    fireEvent.click(screen.getByText("Run setup"));
  };
  const toStep = (bridge: MockBridge, n: number) => {
    fireEvent.click(screen.getByText("Start"));
    if (n < 2) return;
    act(() => bridge.inbound({ type: "channel.test.result", channelId: "c1", ok: true, models: ["m", "big:32b"] }));
    fireEvent.click(screen.getByText("Next: discover models"));
    if (n < 3) return;
    fireEvent.click(screen.getByText("Next: choose evaluator"));
  };

  it("walks the welcome step and blocks Next until a channel passes its test", () => {
    const { bridge } = mk();
    openWizard(bridge);
    expect(screen.getByText("First-run setup wizard")).toBeTruthy();
    expect(screen.getByText(/at least one/)).toBeTruthy();
    fireEvent.click(screen.getByText("Start"));
    expect((screen.getByText("Next: discover models") as HTMLButtonElement).disabled).toBe(true);
    act(() => bridge.inbound({ type: "channel.test.result", channelId: "c1", ok: false, error: "fetch failed ECONNREFUSED" }));
    expect(screen.getByText(/Is it installed and running/)).toBeTruthy();
    expect((screen.getByText("Next: discover models") as HTMLButtonElement).disabled).toBe(true);
    act(() => bridge.inbound({ type: "channel.test.result", channelId: "c1", ok: true, models: ["m"] }));
    expect((screen.getByText("Next: discover models") as HTMLButtonElement).disabled).toBe(false);
  });

  it("adds an openai-compatible channel with URL and key; key goes to secrets, not YAML", () => {
    const { bridge } = mk();
    openWizard(bridge);
    fireEvent.click(screen.getByText("Start"));
    fireEvent.change(screen.getByLabelText("channel preset"), { target: { value: "OpenAI" } });
    expect((screen.getByLabelText("base url") as HTMLInputElement).value).toBe("https://api.openai.com/v1");
    fireEvent.input(screen.getByLabelText("api key"), { target: { value: "sk-secret-123" } });
    fireEvent.click(screen.getByText("Add this channel"));
    expect(bridge.sent).toContainEqual({ type: "secret.set", ref: "channel-openai", value: "sk-secret-123" });
    const saved = bridge.sent.find((m: any) => m.type === "config.set" && m.file === "channels.yaml") as any;
    expect(saved.yaml).toContain("id: openai");
    expect(saved.yaml).toContain("secretRef: channel-openai");
    expect(saved.yaml).not.toContain("sk-secret-123");
  });

  it("hides the API key and URL fields where they do not apply and maps 401 errors", () => {
    const { bridge } = mk();
    openWizard(bridge);
    fireEvent.click(screen.getByText("Start"));
    expect(screen.queryByLabelText("api key")).toBeNull();
    fireEvent.change(screen.getByLabelText("channel preset"), { target: { value: "Claude CLI" } });
    expect(screen.queryByLabelText("base url")).toBeNull();
    act(() => bridge.inbound({ type: "channel.test.result", channelId: "c2", ok: false, error: "GET /models → 401" }));
    expect(screen.getByText(/rejected the API key/)).toBeTruthy();
  });

  it("probes discovered models and shows their abilities", () => {
    const { bridge } = mk();
    openWizard(bridge);
    toStep(bridge, 2);
    expect(bridge.sent).toContainEqual({ type: "channel.probe", channelId: "c1", model: "big:32b", force: false });
    act(() => bridge.inbound({ type: "channel.probe.result", channelId: "c1", model: "big:32b", ok: true, caps: { tools: "native", reasoning: true, contextTokens: 32000 } }));
    expect(screen.getByText(/tools:native · reasoning · 32k ctx/)).toBeTruthy();
  });

  it("builds a rules proposal, lets the user edit a row and applies agents + roles", () => {
    const { bridge, store } = mk();
    openWizard(bridge);
    toStep(bridge, 3);
    fireEvent.click(screen.getByText("Build proposal"));
    expect(bridge.sent).toContainEqual(
      expect.objectContaining({ type: "setup.recommend", mode: "rules", context: expect.objectContaining({ priorities: { speed: 2, cost: 2, quality: 2 } }) }),
    );
    act(() =>
      bridge.inbound({
        type: "setup.recommend.result",
        ok: true,
        assignments: [{ role: "general-worker", channel: "c1", model: "big:32b", reason: "native tools", score: 14, warnings: ["model is ~4B"], source: "rules" }],
        unfilled: [{ role: "image-reader", reason: "no model with: vision" }],
      }),
    );
    expect(screen.getByText(/⚠ model is ~4B/)).toBeTruthy();
    expect(screen.getByText(/disabled: no model with: vision/)).toBeTruthy();
    fireEvent.click(screen.getByText("Apply"));
    const agents = bridge.sent.find((m: any) => m.type === "config.set" && m.file === "agents.yaml") as any;
    expect(agents.yaml).toContain("c1-big-32b");
    const roles = bridge.sent.find((m: any) => m.type === "config.set" && m.file === "roles.yaml") as any;
    expect(roles.yaml).toContain("agent: c1-big-32b");
    expect(roles.yaml).toMatch(/id: image-reader\n\s+enabled: false/);
    expect(store.state.recommendation).toBeUndefined();
    expect(screen.getByText(/Setup complete/)).toBeTruthy();
  });

  it("prefills priced billing and price from probe catalog info on Apply", () => {
    const { bridge } = mk();
    openWizard(bridge);
    toStep(bridge, 3);
    act(() =>
      bridge.inbound({
        type: "channel.probe.result",
        channelId: "c1",
        model: "big:32b",
        ok: true,
        caps: {},
        catalog: { inPerMTok: 1.25, outPerMTok: 10, source: "catalog 2026-11" },
      }),
    );
    fireEvent.click(screen.getByText("Build proposal"));
    act(() => bridge.inbound({ type: "setup.recommend.result", ok: true, assignments: [{ role: "general-worker", channel: "c1", model: "big:32b" }] }));
    fireEvent.click(screen.getByText("Apply"));
    const agents = bridge.sent.find((m: any) => m.type === "config.set" && m.file === "agents.yaml") as any;
    expect(agents.yaml).toContain("billing: priced");
    expect(agents.yaml).toContain("inPerMTok: 1.25");
    expect(agents.yaml).toContain("outPerMTok: 10");
  });

  it("reuses an existing agent for an edited row and can disable a role", () => {
    const { bridge } = mk();
    openWizard(bridge);
    toStep(bridge, 3);
    fireEvent.click(screen.getByText("Build proposal"));
    act(() => bridge.inbound({ type: "setup.recommend.result", ok: true, assignments: [{ role: "general-worker", channel: "c1", model: "big:32b" }] }));
    fireEvent.change(screen.getByLabelText("role general-worker"), { target: { value: "c1:m" } });
    fireEvent.change(screen.getByLabelText("role image-reader"), { target: { value: "" } });
    fireEvent.click(screen.getByText("Apply"));
    const roles = bridge.sent.find((m: any) => m.type === "config.set" && m.file === "roles.yaml") as any;
    expect(roles.yaml).toContain("agent: a1");
  });

  it("AI mode sends the chosen evaluator, and a failure offers a rules fallback", () => {
    const { bridge, store } = mk();
    openWizard(bridge);
    toStep(bridge, 3);
    fireEvent.click(screen.getByLabelText(/AI refine/));
    fireEvent.change(screen.getByLabelText("evaluator"), { target: { value: "c1:big:32b" } });
    fireEvent.click(screen.getByText("Build proposal"));
    expect(bridge.sent).toContainEqual(
      expect.objectContaining({ type: "setup.recommend", mode: "ai", evaluator: { channel: "c1", model: "big:32b" } }),
    );
    act(() => bridge.inbound({ type: "setup.recommend.result", ok: false, error: "could not parse recommendation" }));
    expect(screen.getByText(/could not parse/)).toBeTruthy();
    expect((screen.getByText("Apply") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByText("Use rules instead"));
    expect(bridge.sent.filter((m: any) => m.type === "setup.recommend").at(-1)).toEqual({ type: "setup.recommend", mode: "rules" });
    expect(store.state.recommendBusy).toBe(true);
  });

  it("Back buttons return to the previous step and Close dismisses the wizard", () => {
    const { bridge, store } = mk();
    openWizard(bridge);
    toStep(bridge, 3);
    fireEvent.click(screen.getByText("Back"));
    expect(screen.getByText(/checks what each model can do|wait while Stewart checks/i)).toBeTruthy();
    fireEvent.click(screen.getByText("Close"));
    expect(store.state.wizardOpen).toBe(false);
  });

  it("dismisses a v1 draft without applying", () => {
    const { bridge, store } = mk();
    fireEvent.click(screen.getAllByText("Settings")[0]);
    act(() => bridge.inbound(configReply));
    fireEvent.click(screen.getByText("settings"));
    act(() => bridge.inbound({ type: "v1.draft", files: { "agents.yaml": "x" }, warnings: [] }));
    fireEvent.click(screen.getByText("Dismiss"));
    expect(store.state.v1Draft).toBeUndefined();
    expect(bridge.sent.some((m) => m.type === "config.importV1")).toBe(false);
  });

  const openAgents = (bridge: MockBridge, reply: typeof configReply = configReply) => {
    fireEvent.click(screen.getAllByText("Settings")[0]);
    act(() => bridge.inbound(reply));
    fireEvent.click(screen.getByText("agents"));
  };

  it("agents tab sends channel.test for enabled channels only", () => {
    const { bridge } = mk();
    const reply = {
      ...configReply,
      summary: {
        ...configReply.summary,
        channels: [...configReply.summary.channels, { id: "c3", type: "ollama", enabled: false, baseUrl: "http://z" }],
      },
    };
    openAgents(bridge, reply);
    expect(bridge.sent).toContainEqual({ type: "channel.test", channelId: "c1" });
    expect(bridge.sent).toContainEqual({ type: "channel.test", channelId: "c2" });
    expect(bridge.sent).not.toContainEqual({ type: "channel.test", channelId: "c3" });
  });

  it("agents tab does not re-test a channel that already has a result", () => {
    const { bridge } = mk();
    fireEvent.click(screen.getAllByText("Settings")[0]);
    act(() => bridge.inbound(configReply));
    act(() => bridge.inbound({ type: "channel.test.result", channelId: "c1", ok: true, models: ["m1"] }));
    fireEvent.click(screen.getByText("agents"));
    expect(bridge.sent.filter((m) => m.type === "channel.test" && m.channelId === "c1")).toHaveLength(0);
    expect(bridge.sent).toContainEqual({ type: "channel.test", channelId: "c2" });
  });

  it("agent model select lists tested models and ignores failed test results", () => {
    const { bridge } = mk();
    openAgents(bridge);
    act(() => bridge.inbound({ type: "channel.test.result", channelId: "c1", ok: true, models: ["m1", "m2"] }));
    act(() => bridge.inbound({ type: "channel.test.result", channelId: "c2", ok: false, error: "down", models: ["bad"] }));
    fireEvent.click(screen.getAllByText("Edit")[1]);
    fireEvent.click(screen.getAllByText("Edit")[0]);
    const selects = screen.getAllByText("model").map((l) => l.parentElement!.querySelector("select")!);
    expect([...selects[0].options].map((o) => o.value)).toEqual(["", "m1", "m2", "m"]);
    expect([...selects[1].options].map((o) => o.value)).toEqual(["", "v"]);
    const channelSel = screen.getAllByText("channel")[0].parentElement!.querySelector("select")!;
    expect([...channelSel.options].map((o) => o.value)).toEqual(["", "c1", "c2"]);
  });

  it("probe shows probing and disables the button until a result arrives", () => {
    const { bridge } = mk();
    openAgents(bridge);
    const btn = screen.getAllByText("Probe")[0] as HTMLButtonElement;
    fireEvent.click(btn);
    expect(screen.getByText("probing…")).toBeTruthy();
    expect(btn.disabled).toBe(true);
    act(() => bridge.inbound({ type: "channel.probe.result", channelId: "c2", model: "v", ok: true, probedAt: 1 }));
    expect(screen.getByText("probing…")).toBeTruthy();
    expect(btn.disabled).toBe(true);
  });

  it("successful probe shows ✓ probed and re-enables the button", () => {
    const { bridge } = mk();
    openAgents(bridge);
    const btn = screen.getAllByText("Probe")[0] as HTMLButtonElement;
    fireEvent.click(btn);
    act(() => bridge.inbound({ type: "channel.probe.result", channelId: "c1", model: "m", ok: true, probedAt: 1 }));
    expect(screen.queryByText("probing…")).toBeNull();
    expect(screen.getByText("✓ probed")).toBeTruthy();
    expect(btn.disabled).toBe(false);
  });

  it("failed probe shows the error and re-enables the button", () => {
    const { bridge } = mk();
    openAgents(bridge);
    const btn = screen.getAllByText("Probe")[0] as HTMLButtonElement;
    fireEvent.click(btn);
    act(() => bridge.inbound({ type: "channel.probe.result", channelId: "c1", model: "m", ok: false, error: "model not found" }));
    expect(screen.queryByText("probing…")).toBeNull();
    expect(screen.getByText("✗ model not found")).toBeTruthy();
    expect(screen.queryByText("✓ probed")).toBeNull();
    expect(btn.disabled).toBe(false);
  });
});

describe("modelsForChannel", () => {
  const channels = [
    { id: "c1", type: "ollama", enabled: true, extraModels: ["x1", "m1"], modelCaps: { m2: {}, m1: {} } },
    { id: "c2", type: "openai-compatible", enabled: true },
  ];

  it("merges tested, extra and capability models and de-duplicates them", () => {
    const tests = { c1: { ok: true, models: ["m1", "m2", "m3"] } };
    expect(modelsForChannel(channels, tests, "c1")).toEqual(["m1", "m2", "m3", "x1"]);
  });

  it("ignores a failed test result but keeps configured models", () => {
    const tests = { c1: { ok: false, models: ["bad"], error: "down" } };
    expect(modelsForChannel(channels, tests, "c1")).toEqual(["x1", "m1", "m2"]);
  });

  it("returns no models for a channel without config or tests", () => {
    expect(modelsForChannel(channels, {}, "c2")).toEqual([]);
  });

  it("returns [] for an unknown channel with no test result", () => {
    expect(modelsForChannel(channels, {}, "zz")).toEqual([]);
  });
});

describe("webview theme styles", () => {
  const css = readFileSync("src/styles.css", "utf8");

  it("paints body, inputs and accents from theme variables", () => {
    expect(css).toMatch(/body[^}]*background:\s*var\(--st-bg\)/);
    expect(css).toMatch(/body[^}]*color:\s*var\(--st-fg\)/);
    expect(css).toContain("--st-fg: var(--vscode-foreground");
    expect(css).toContain("--st-bg: var(--vscode-sideBar-background");
    expect(css).not.toMatch(/background:\s*transparent/);
    expect(css).toMatch(/select[^{]*\{[^}]*background:\s*var\(--st-input-bg\)/);
    expect(css).toMatch(/select option\s*\{[^}]*color:\s*var\(--st-input-fg\)/);
    expect(css).toMatch(/\.send\s*\{[^}]*background:\s*var\(--st-accent\)/);
  });
});

describe("agentCosts", () => {
  const chs = [
    { id: "cl", type: "claude-cli", enabled: true },
    { id: "ol", type: "ollama", enabled: true },
  ];
  it("flags claude-cli by default, priced/reported billing, and explicit costs", () => {
    expect(agentCosts({ id: "a", channel: "cl", model: "m" }, chs)).toBe(true);
    expect(agentCosts({ id: "a", channel: "ol", model: "m", billing: "priced" }, chs)).toBe(true);
    expect(agentCosts({ id: "a", channel: "ol", model: "m", costs: true }, chs)).toBe(true);
  });
  it("does not flag free/unmetered/local agents, explicit false, or missing agent", () => {
    expect(agentCosts({ id: "a", channel: "ol", model: "m" }, chs)).toBe(false);
    expect(agentCosts({ id: "a", channel: "cl", model: "m", billing: "free" }, chs)).toBe(false);
    expect(agentCosts({ id: "a", channel: "cl", model: "m", costs: false }, chs)).toBe(false);
    expect(agentCosts(undefined, chs)).toBe(false);
  });
});
