import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { cleanup } from "@testing-library/preact";
import { render, screen, fireEvent, act, within } from "@testing-library/preact";
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

  it("posts the chosen grant for each approval button", () => {
    const { bridge } = mk();
    const cases = [
      ["once", "Once"],
      ["chat", "This chat"],
      ["always", "Always"],
      ["deny", "Deny"],
    ] as const;
    for (const [grant, label] of cases) {
      act(() =>
        bridge.inbound(ev("approval.request", { approvalId: `a-${grant}`, tool: "RunTerminal", args: {}, category: "COMMANDS" })),
      );
      fireEvent.click(screen.getByText(label));
      expect(bridge.sent).toContainEqual({ type: "chat.approve", approvalId: `a-${grant}`, grant });
    }
  });

  it("shows the streaming placeholder until the run finishes", () => {
    const { bridge } = mk();
    act(() => {
      bridge.inbound(ev("run.started", { title: "x" }));
      bridge.inbound(ev("tool.request", { callId: "c1", tool: "ReadFile", args: {}, category: "READ" }));
    });
    expect(screen.getByText("…")).toBeTruthy();
    expect(screen.queryByText("Insert into editor")).toBeNull();
    act(() => bridge.inbound(ev("run.finished", { status: "done" })));
    expect(screen.queryByText("…")).toBeNull();
  });

  it("Enter sends the draft, Shift+Enter does not, and empty Enter posts nothing", () => {
    const { bridge } = mk();
    const ta = screen.getByPlaceholderText("Ask Stewart") as HTMLTextAreaElement;
    fireEvent.input(ta, { target: { value: "draft text" } });
    fireEvent.keyDown(ta, { key: "Enter", shiftKey: true });
    expect(ta.value).toBe("draft text");
    expect(bridge.sent.some((m) => m.type === "chat.send")).toBe(false);
    fireEvent.keyDown(ta, { key: "Enter" });
    expect(bridge.sent).toContainEqual(expect.objectContaining({ type: "chat.send", text: "draft text" }));
    expect(ta.value).toBe("");
    fireEvent.keyDown(ta, { key: "Enter" });
    expect(bridge.sent.filter((m) => m.type === "chat.send")).toHaveLength(1);
  });

  it("keeps the composer draft when inbound events rerender the chat", () => {
    const { bridge } = mk();
    const ta = screen.getByPlaceholderText("Ask Stewart") as HTMLTextAreaElement;
    fireEvent.input(ta, { target: { value: "keep me" } });
    act(() => {
      bridge.inbound(ev("run.started", { title: "x" }));
      bridge.inbound(ev("text_delta", { seq: 0, text: "reply" }));
    });
    expect(ta.value).toBe("keep me");
  });

  it("sets the budget profile when a profile button is clicked", () => {
    const { store } = mk();
    const group = screen.getByRole("group", { name: "budget profile" });
    const deep = within(group).getByRole("button", { name: "deep" });
    fireEvent.click(deep);
    expect(store.state.profileChoice).toBe("deep");
    expect(deep.getAttribute("aria-pressed")).toBe("true");
  });

  it("presses auto by default and leaves the other profile buttons unpressed", () => {
    mk();
    const group = screen.getByRole("group", { name: "budget profile" });
    for (const [name, pressed] of [["auto", "true"], ["quick", "false"], ["normal", "false"], ["deep", "false"]] as const) {
      expect(within(group).getByRole("button", { name }).getAttribute("aria-pressed")).toBe(pressed);
    }
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

  it("drop attaches valid images and rejects the rest of a mixed batch", async () => {
    const { store } = mk();
    const reject = vi.spyOn(store, "rejectAttachment");
    const composer = document.querySelector(".composer") as HTMLElement;
    fireEvent.drop(composer, {
      dataTransfer: { files: [pngFile(), new File(["x"], "a.txt", { type: "text/plain" })] },
    });
    await flush();
    expect(store.state.pendingImages).toHaveLength(1);
    expect(reject).toHaveBeenCalledWith("only PNG, JPEG, GIF and WebP images can be attached");
  });

  it("paste attaches file items from the clipboard", async () => {
    const { store } = mk();
    const ta = screen.getByPlaceholderText("Ask Stewart");
    fireEvent.paste(ta, {
      clipboardData: {
        items: [{ kind: "string", type: "text/plain" }, { kind: "file", getAsFile: () => pngFile() }],
      },
    });
    await flush();
    expect(store.state.pendingImages).toHaveLength(1);
  });
});

describe("webview editor insert", () => {
  it("does not offer editor insert on assistant messages", () => {
    const { bridge } = mk();
    act(() => {
      bridge.inbound(ev("run.started", { title: "x" }));
      bridge.inbound(ev("text_delta", { seq: 0, text: "use this" }));
      bridge.inbound(ev("run.finished", { status: "done" }));
    });
    expect(screen.queryByText("Insert into editor")).toBeNull();
    expect(bridge.sent).toEqual([{ type: "ready" }]);
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

  it("toggles a role skill on and off", () => {
    const { bridge } = mk();
    openRoles(bridge);
    fireEvent.click(screen.getAllByText("Edit")[1]);
    const boxes = document.querySelectorAll(".skill-ticks input[type=checkbox]");
    fireEvent.click(boxes[1]);
    let set = bridge.sent.filter((m) => m.type === "config.set").pop() as { yaml: string } | undefined;
    expect(set?.yaml).toContain("tdd");
    act(() =>
      bridge.inbound({
        ...configReply,
        summary: {
          ...configReply.summary,
          roles: [
            configReply.summary.roles[0],
            { ...configReply.summary.roles[1], skills: ["tdd"] },
          ],
        },
      }),
    );
    const boxes2 = document.querySelectorAll(".skill-ticks input[type=checkbox]");
    expect((boxes2[1] as HTMLInputElement).checked).toBe(true);
    fireEvent.click(boxes2[1]);
    set = bridge.sent.filter((m) => m.type === "config.set").pop() as { yaml: string } | undefined;
    expect(set?.yaml).not.toContain("tdd");
  });

  it("edits turnBudget as unlimited, number and blank", () => {
    const { bridge } = mk();
    openRoles(bridge);
    fireEvent.click(screen.getAllByText("Edit")[0]);
    const input = screen.getByText("turnBudget").parentElement!.querySelector("input")!;
    fireEvent.input(input, { target: { value: "unlimited" } });
    let set = bridge.sent.filter((m) => m.type === "config.set").pop() as { yaml: string } | undefined;
    expect(set?.yaml).toContain("turnBudget: unlimited");
    fireEvent.input(input, { target: { value: "12" } });
    set = bridge.sent.filter((m) => m.type === "config.set").pop() as { yaml: string } | undefined;
    expect(set?.yaml).toContain("turnBudget: 12");
    fireEvent.input(input, { target: { value: "" } });
    set = bridge.sent.filter((m) => m.type === "config.set").pop() as { yaml: string } | undefined;
    expect(set?.yaml).not.toContain("turnBudget");
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
  const probeDone = {
    type: "setup.probe.result" as const,
    status: "done" as const,
    runId: 1,
    ranking: false,
    items: [
      { channel: "c1", model: "m", state: "green" as const },
      { channel: "c1", model: "big:32b", state: "green" as const },
    ],
    counts: { queued: 0, running: 0, green: 2, orange: 0, red: 0, skipped: 0 },
    green: [
      { channel: "c1", model: "m" },
      { channel: "c1", model: "big:32b" },
    ],
  };
  const toStep = (bridge: MockBridge, n: number) => {
    fireEvent.click(screen.getByText("Start"));
    if (n < 2) return;
    act(() => bridge.inbound({ type: "channel.test.result", channelId: "c1", ok: true, models: ["m", "big:32b"] }));
    fireEvent.click(screen.getByText("Next: discover models"));
    if (n < 3) return;
    act(() => bridge.inbound(probeDone));
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
    fireEvent.click(screen.getByLabelText("source new"));
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
    fireEvent.click(screen.getByLabelText("source new"));
    expect(screen.queryByLabelText("api key")).toBeNull();
    fireEvent.change(screen.getByLabelText("channel preset"), { target: { value: "Claude CLI" } });
    expect(screen.queryByLabelText("base url")).toBeNull();
    fireEvent.click(screen.getByLabelText("source existing"));
    act(() => bridge.inbound({ type: "channel.test.result", channelId: "c2", ok: false, error: "GET /models → 401" }));
    expect(screen.getByText(/rejected the API key/)).toBeTruthy();
  });

  it("existing mode offers an evaluator channel + agent select seeded to the first ok channel's agent", () => {
    const { bridge } = mk();
    openWizard(bridge);
    fireEvent.click(screen.getByText("Start"));
    expect((screen.getByText("Next: discover models") as HTMLButtonElement).disabled).toBe(true);
    act(() => bridge.inbound({ type: "channel.test.result", channelId: "c1", ok: true, models: ["m", "big:32b"] }));
    act(() => bridge.inbound({ type: "channel.test.result", channelId: "c2", ok: true, models: ["v"] }));
    const chanSel = screen.getByLabelText("evaluator channel") as HTMLSelectElement;
    expect(chanSel.value).toBe("c1");
    const agentSel = screen.getByLabelText("evaluator agent") as HTMLSelectElement;
    expect(agentSel.value).toBe("c1:m");
    expect([...agentSel.options].map((o) => o.text)).toEqual(["a1 (m)"]);
    expect(document.querySelector('input[type="checkbox"]')).toBeNull();
    expect((screen.getByText("Next: discover models") as HTMLButtonElement).disabled).toBe(false);
    fireEvent.change(chanSel, { target: { value: "c2" } });
    expect([...agentSel.options].map((o) => o.text)).toEqual(["va (v)"]);
    expect(agentSel.value).toBe("c2:v");
  });

  it("falls back to channel models when the chosen channel has no agents", () => {
    const { bridge } = mk();
    fireEvent.click(screen.getAllByText("Settings")[0]);
    act(() =>
      bridge.inbound({
        ...configReply,
        summary: {
          ...configReply.summary,
          channels: [...configReply.summary.channels, { id: "c3", type: "ollama", enabled: true, baseUrl: "http://z" }],
        },
      } as typeof configReply),
    );
    fireEvent.click(screen.getByText("Run setup"));
    fireEvent.click(screen.getByText("Start"));
    act(() => bridge.inbound({ type: "channel.test.result", channelId: "c1", ok: true, models: ["m"] }));
    act(() => bridge.inbound({ type: "channel.test.result", channelId: "c3", ok: true, models: ["x", "y"] }));
    fireEvent.change(screen.getByLabelText("evaluator channel"), { target: { value: "c3" } });
    expect(screen.getByText(/No agents on this channel/)).toBeTruthy();
    const agentSel = screen.getByLabelText("evaluator agent") as HTMLSelectElement;
    expect([...agentSel.options].map((o) => o.value)).toEqual(["c3:x", "c3:y"]);
    expect(agentSel.value).toBe("c3:x");
  });

  it("step-1 evaluator choice carries into step 3 and setup.recommend in AI mode", () => {
    const { bridge } = mk();
    openWizard(bridge);
    toStep(bridge, 3);
    fireEvent.click(screen.getByLabelText(/AI refine/));
    expect((screen.getByLabelText("evaluator") as HTMLSelectElement).value).toBe("c1:m");
    fireEvent.click(screen.getByText("Build proposal"));
    expect(bridge.sent).toContainEqual(
      expect.objectContaining({ type: "setup.recommend", mode: "ai", evaluator: { channel: "c1", model: "m" } }),
    );
  });

  it("existing mode hides the add form; new mode shows it and offers the added channel's models as evaluator", () => {
    const { bridge } = mk();
    openWizard(bridge);
    fireEvent.click(screen.getByText("Start"));
    expect(screen.queryByText("Add this channel")).toBeNull();
    fireEvent.click(screen.getByLabelText("source new"));
    expect(screen.getByText("Add this channel")).toBeTruthy();
    fireEvent.click(screen.getByText("Add this channel"));
    act(() =>
      bridge.inbound({
        ...configReply,
        summary: {
          ...configReply.summary,
          channels: [...configReply.summary.channels, { id: "local-ollama", type: "ollama", enabled: true, baseUrl: "http://localhost:11434" }],
        },
      } as typeof configReply),
    );
    act(() => bridge.inbound({ type: "channel.test.result", channelId: "local-ollama", ok: true, models: ["x", "y"] }));
    const chanSel = screen.getByLabelText("evaluator channel") as HTMLSelectElement;
    expect([...chanSel.options].map((o) => o.value)).toEqual(["local-ollama"]);
    const agentSel = screen.getByLabelText("evaluator agent") as HTMLSelectElement;
    expect([...agentSel.options].map((o) => o.value)).toEqual(["local-ollama:x", "local-ollama:y"]);
    expect(agentSel.value).toBe("local-ollama:x");
    expect((screen.getByText("Next: discover models") as HTMLButtonElement).disabled).toBe(false);
  });

  it("shows no source radios and the add form when no channels are configured", () => {
    const { bridge } = mk();
    fireEvent.click(screen.getAllByText("Settings")[0]);
    act(() =>
      bridge.inbound({
        ...configReply,
        summary: { ...configReply.summary, channels: [], agents: [] },
      } as typeof configReply),
    );
    fireEvent.click(screen.getByText("Run setup"));
    fireEvent.click(screen.getByText("Start"));
    expect(screen.queryByLabelText("source existing")).toBeNull();
    expect(screen.queryByLabelText("source new")).toBeNull();
    expect(screen.getByText("Add this channel")).toBeTruthy();
  });

  it("starts the smoke queue once and renders queued/running/green/orange/red/skipped states", () => {
    const { bridge } = mk();
    openWizard(bridge);
    toStep(bridge, 2);
    const starts = bridge.sent.filter((m: any) => m.type === "setup.probe.start");
    expect(starts).toHaveLength(1);
    expect(starts[0]).toEqual(
      expect.objectContaining({
        candidates: [
          { channel: "c1", model: "m" },
          { channel: "c1", model: "big:32b" },
        ],
        evaluator: { channel: "c1", model: "m" },
      }),
    );
    expect((screen.getByText("Next: choose evaluator") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getAllByText("queued").length).toBe(2);
    act(() =>
      bridge.inbound({
        type: "setup.probe.result",
        status: "running",
        runId: 1,
        ranking: false,
        items: [
          { channel: "c1", model: "m", state: "running" },
          { channel: "c1", model: "big:32b", state: "queued" },
        ],
        counts: { queued: 1, running: 1, green: 0, orange: 0, red: 0, skipped: 0 },
        green: [],
      }),
    );
    expect(screen.getByText("probing…")).toBeTruthy();
    act(() =>
      bridge.inbound({
        type: "setup.probe.result",
        status: "done",
        runId: 1,
        ranking: false,
        items: [
          { channel: "c1", model: "m", state: "green" },
          { channel: "c1", model: "big:32b", state: "orange", reason: "no response within 30000ms" },
        ],
        counts: { queued: 0, running: 0, green: 1, orange: 1, red: 0, skipped: 0 },
        green: [{ channel: "c1", model: "m" }],
      }),
    );
    expect(screen.getByText(/✓ passed/)).toBeTruthy();
    expect(screen.getByText(/timed out — no response within 30000ms/)).toBeTruthy();
    expect((screen.getByText("Next: choose evaluator") as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByText("Retry failed")).toBeTruthy();
  });

  it("accept and continue cancels the queue and advances with partial results", () => {
    const { bridge } = mk();
    openWizard(bridge);
    toStep(bridge, 2);
    act(() =>
      bridge.inbound({
        type: "setup.probe.result",
        status: "running",
        runId: 1,
        ranking: false,
        items: [
          { channel: "c1", model: "m", state: "running" },
          { channel: "c1", model: "big:32b", state: "queued" },
        ],
        counts: { queued: 1, running: 1, green: 0, orange: 0, red: 0, skipped: 0 },
        green: [],
      }),
    );
    fireEvent.click(screen.getByText("Accept and continue"));
    expect(bridge.sent).toContainEqual({ type: "setup.probe.cancel" });
    expect(screen.getByText(/decide who matches models to roles/)).toBeTruthy();
  });

  it("retry failed posts setup.probe.retry and does not restart the queue on rerender", () => {
    const { bridge } = mk();
    openWizard(bridge);
    toStep(bridge, 2);
    act(() =>
      bridge.inbound({
        type: "setup.probe.result",
        status: "done",
        runId: 1,
        ranking: false,
        items: [
          { channel: "c1", model: "m", state: "green" },
          { channel: "c1", model: "big:32b", state: "red", reason: "HTTP 500" },
        ],
        counts: { queued: 0, running: 0, green: 1, orange: 0, red: 1, skipped: 0 },
        green: [{ channel: "c1", model: "m" }],
      }),
    );
    fireEvent.click(screen.getByText("Retry failed"));
    expect(bridge.sent).toContainEqual({ type: "setup.probe.retry" });
    expect(bridge.sent.filter((m: any) => m.type === "setup.probe.start")).toHaveLength(1);
    expect(screen.getByText(/✗ HTTP 500/)).toBeTruthy();
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
    const upd = bridge.sent.find((m: any) => m.type === "setup.session.update") as any;
    expect(upd.patch.files["agents.yaml"]).toContain("c1-big-32b");
    expect(upd.patch.files["roles.yaml"]).toContain("agent: c1-big-32b");
    expect(upd.patch.files["roles.yaml"]).toMatch(/id: image-reader\n\s+enabled: false/);
    expect(bridge.sent).toContainEqual({ type: "setup.review" });
    act(() => bridge.inbound({ type: "setup.review.result", token: "tok1" }));
    expect(bridge.sent).toContainEqual({ type: "setup.approve", token: "tok1" });
    act(() => bridge.inbound({ type: "setup.approve.result", ok: true }));
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
    const agents = (bridge.sent.find((m: any) => m.type === "setup.session.update") as any).patch.files["agents.yaml"];
    expect(agents).toContain("billing: priced");
    expect(agents).toContain("inPerMTok: 1.25");
    expect(agents).toContain("outPerMTok: 10");
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
    const roles = (bridge.sent.find((m: any) => m.type === "setup.session.update") as any).patch.files["roles.yaml"];
    expect(roles).toContain("agent: a1");
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
    expect(screen.getByText(/smoke-tests every model/)).toBeTruthy();
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

  it("serializes bool, number, list and select controls to typed YAML values", () => {
    const { bridge } = mk();
    fireEvent.click(screen.getAllByText("Settings")[0]);
    act(() => bridge.inbound(configReply));
    fireEvent.click(screen.getAllByText("Edit")[0]);
    const field = (label: string) => screen.getByText(label).parentElement!;
    fireEvent.change(field("enabled").querySelector("select")!, { target: { value: "false" } });
    fireEvent.input(field("maxParallel").querySelector("input")!, { target: { value: "4" } });
    fireEvent.input(field("extraModels (csv)").querySelector("input")!, { target: { value: "a, b" } });
    fireEvent.change(field("type").querySelector("select")!, { target: { value: "openai-compatible" } });
    fireEvent.click(screen.getByText("Save"));
    const set = bridge.sent.find((m) => m.type === "config.set" && m.file === "channels.yaml") as any;
    const c1 = (parse(set.yaml) as { items: Record<string, unknown>[] }).items.find((c) => c.id === "c1")!;
    expect(c1.enabled).toBe(false);
    expect(c1.maxParallel).toBe(4);
    expect(c1.extraModels).toEqual(["a", "b"]);
    expect(c1.type).toBe("openai-compatible");
  });

  it("does not leak an unsaved channel draft across tab switches", () => {
    const { bridge } = mk();
    fireEvent.click(screen.getAllByText("Settings")[0]);
    act(() => bridge.inbound(configReply));
    fireEvent.click(screen.getByText("+ Add"));
    fireEvent.input(document.querySelector(".form input")!, { target: { value: "draft-ch" } });
    expect(screen.getByDisplayValue("draft-ch")).toBeTruthy();
    fireEvent.click(screen.getByText("agents"));
    expect(screen.queryByDisplayValue("draft-ch")).toBeNull();
    fireEvent.click(screen.getAllByText("Edit")[0]);
    const channelSelect = screen.getByText("channel").parentElement!.querySelector("select") as HTMLSelectElement;
    expect(channelSelect.value).toBe("c1");
    expect((screen.getByText("model").parentElement!.querySelector("select") as HTMLSelectElement).value).toBe("m");
    fireEvent.click(screen.getByText("channels"));
    expect(screen.queryByDisplayValue("draft-ch")).toBeNull();
    expect(screen.getAllByText("Remove")).toHaveLength(2);
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

describe("webview store replies", () => {
  const mkStore = () => {
    const bridge = new MockBridge();
    const store = new Store(bridge);
    return { bridge, store };
  };

  it("ready and unknown replies notify no listeners", () => {
    const { bridge, store } = mkStore();
    const spy = vi.fn();
    store.subscribe(spy);
    bridge.inbound({ type: "ready" });
    bridge.inbound({ type: "mystery" } as never);
    expect(spy).not.toHaveBeenCalled();
    expect(store.state.items).toHaveLength(0);
  });

  it("insertText replies carry incrementing seq numbers", () => {
    const { bridge, store } = mkStore();
    bridge.inbound({ type: "insertText", text: "one" });
    bridge.inbound({ type: "insertText", text: "two" });
    expect(store.state.composerInsert).toEqual({ text: "two", seq: 2 });
  });

  it("error replies append ordered system items and record lastError", () => {
    const { bridge, store } = mkStore();
    bridge.inbound({ type: "error", message: "first" });
    bridge.inbound({ type: "error", message: "second" });
    expect(store.state.lastError).toBe("second");
    expect(store.state.items.map((i) => i.text)).toEqual(["error: first", "error: second"]);
    expect(new Set(store.state.items.map((i) => i.id)).size).toBe(2);
  });

  it("setup review/approve/undo replies drive the staged-apply flow", () => {
    const { bridge, store } = mkStore();
    bridge.inbound({ type: "setup.session.result", phase: "review" });
    expect(store.state.setupPhase).toBe("review");
    bridge.inbound({ type: "setup.review.result", token: "tok" });
    expect(bridge.sent).toContainEqual({ type: "setup.approve", token: "tok" });
    bridge.inbound({ type: "setup.review.result", error: "no token" });
    expect(store.state.setupError).toBe("no token");
    expect(bridge.sent.filter((m) => m.type === "setup.approve")).toHaveLength(1);
    bridge.inbound({ type: "setup.approve.result", ok: true });
    expect(store.state.setupSaved).toBe(true);
    store.setupUndo();
    expect(bridge.sent).toContainEqual({ type: "setup.undo" });
    bridge.inbound({ type: "setup.undo.result", ok: false, error: "nope" });
    expect(store.state.setupSaved).toBe(false);
    expect(store.state.setupError).toBe("nope");
  });

  it("a failed recommend clears a previous recommendation", () => {
    const { bridge, store } = mkStore();
    bridge.inbound({
      type: "setup.recommend.result",
      ok: true,
      assignments: [{ role: "r", channel: "c", model: "m" }],
    });
    expect(store.state.recommendation?.assignments).toHaveLength(1);
    bridge.inbound({ type: "setup.recommend.result", ok: false, error: "bad" });
    expect(store.state.recommendation).toBeUndefined();
    expect(store.state.recommendError).toBe("bad");
    expect(store.state.recommendBusy).toBe(false);
  });
});

describe("wizard apply agent building", () => {
  type Chan = { id: string; type: string; enabled: boolean };
  type Ag = { id: string; channel: string; model: string; effort?: string };
  type Rol = { id: string; enabled: boolean; agent?: string; skills?: string[]; tools?: string[] };

  const reply = (summary: { channels: Chan[]; agents?: Ag[]; roles?: Rol[] }): { type: "config" } & ConfigReply => ({
    type: "config" as const,
    files: {},
    summary: {
      channels: summary.channels,
      agents: summary.agents ?? [],
      roles: summary.roles ?? [],
      skills: [],
      settings: {},
    },
    errors: [],
  });

  const openWizard = (bridge: MockBridge, cfg: ReturnType<typeof reply>) => {
    fireEvent.click(screen.getAllByText("Settings")[0]);
    act(() => bridge.inbound(cfg));
    fireEvent.click(screen.getByText("Run setup"));
    fireEvent.click(screen.getByText("Start"));
  };

  const driveToReview = (
    bridge: MockBridge,
    opts: {
      testModels: Record<string, string[]>;
      green: { channel: string; model: string }[];
      catalogs?: Record<string, { inPerMTok?: number; outPerMTok?: number; source: string }>;
    },
  ) => {
    for (const [channelId, models] of Object.entries(opts.testModels)) {
      act(() => bridge.inbound({ type: "channel.test.result", channelId, ok: true, models }));
    }
    fireEvent.click(screen.getByText("Next: discover models"));
    act(() =>
      bridge.inbound({
        type: "setup.probe.result",
        status: "done",
        runId: 1,
        ranking: false,
        items: opts.green.map((g) => ({ channel: g.channel, model: g.model, state: "green" as const })),
        counts: { queued: 0, running: 0, green: opts.green.length, orange: 0, red: 0, skipped: 0 },
        green: opts.green,
      }),
    );
    fireEvent.click(screen.getByText("Next: choose evaluator"));
    for (const [ref, catalog] of Object.entries(opts.catalogs ?? {})) {
      const i = ref.indexOf(":");
      act(() =>
        bridge.inbound({
          type: "channel.probe.result",
          channelId: ref.slice(0, i),
          model: ref.slice(i + 1),
          ok: true,
          caps: {},
          catalog,
        }),
      );
    }
    fireEvent.click(screen.getByText("Build proposal"));
  };

  const applyWith = (
    bridge: MockBridge,
    rec: {
      assignments: { role: string; channel: string; model: string; reason?: string; warnings?: string[] }[];
      unfilled?: { role: string; reason: string }[];
    },
  ) => {
    act(() => bridge.inbound({ type: "setup.recommend.result", ok: true, assignments: rec.assignments, unfilled: rec.unfilled }));
    fireEvent.click(screen.getByText("Apply"));
    const upd = bridge.sent.find((m) => m.type === "setup.session.update") as any;
    return {
      agents: (parse(upd.patch.files["agents.yaml"]) as { items: Record<string, unknown>[] }).items,
      roles: (parse(upd.patch.files["roles.yaml"]) as { items: Record<string, unknown>[] }).items,
    };
  };

  const agent = (agents: Record<string, unknown>[], channel: string, model: string) =>
    agents.find((a) => a.channel === channel && a.model === model)!;

  it("reuses one agent when two roles pick the same pair", () => {
    const { bridge } = mk();
    openWizard(
      bridge,
      reply({
        channels: [{ id: "c1", type: "ollama", enabled: true }],
        roles: [{ id: "r1", enabled: true }, { id: "r2", enabled: true }],
      }),
    );
    driveToReview(bridge, {
      testModels: { c1: ["m", "n"] },
      green: [
        { channel: "c1", model: "m" },
        { channel: "c1", model: "n" },
      ],
    });
    const { agents, roles } = applyWith(bridge, {
      assignments: [
        { role: "r1", channel: "c1", model: "m" },
        { role: "r2", channel: "c1", model: "m" },
      ],
    });
    const created = agents.filter((a) => a.channel === "c1" && a.model === "m");
    expect(created).toHaveLength(1);
    expect(created[0]!.id).toBe("c1-m");
    expect(roles.find((r) => r.id === "r1")!.agent).toBe("c1-m");
    expect(roles.find((r) => r.id === "r2")!.agent).toBe("c1-m");
  });

  it("splits refs on the first colon and de-collides sanitized agent ids", () => {
    const { bridge } = mk();
    openWizard(
      bridge,
      reply({
        channels: [{ id: "c1", type: "ollama", enabled: true }],
        roles: [{ id: "r1", enabled: true }, { id: "r2", enabled: true }],
      }),
    );
    driveToReview(bridge, {
      testModels: { c1: ["a:b", "a-b"] },
      green: [
        { channel: "c1", model: "a:b" },
        { channel: "c1", model: "a-b" },
      ],
    });
    const { agents, roles } = applyWith(bridge, {
      assignments: [
        { role: "r1", channel: "c1", model: "a:b" },
        { role: "r2", channel: "c1", model: "a-b" },
      ],
    });
    expect(agent(agents, "c1", "a:b").id).toBe("c1-a-b");
    expect(agent(agents, "c1", "a-b").id).toBe("c1-a-b-2");
    expect(roles.find((r) => r.id === "r1")!.agent).toBe("c1-a-b");
    expect(roles.find((r) => r.id === "r2")!.agent).toBe("c1-a-b-2");
  });

  it("derives billing from catalog price, zero price, channel type and claude costs", () => {
    const { bridge } = mk();
    openWizard(
      bridge,
      reply({
        channels: [
          { id: "c1", type: "ollama", enabled: true },
          { id: "c2", type: "openai-compatible", enabled: true },
          { id: "c3", type: "claude-cli", enabled: true },
        ],
        roles: ["r1", "r2", "r3", "r4", "r5", "r6"].map((id) => ({ id, enabled: true })),
      }),
    );
    driveToReview(bridge, {
      testModels: { c1: ["m"], c2: ["v", "w", "x", "z"], c3: ["sonnet"] },
      green: [
        { channel: "c1", model: "m" },
        { channel: "c2", model: "v" },
        { channel: "c2", model: "w" },
        { channel: "c2", model: "x" },
        { channel: "c2", model: "z" },
        { channel: "c3", model: "sonnet" },
      ],
      catalogs: {
        "c2:v": { inPerMTok: 0, source: "catalog 2026-11" },
        "c2:w": { inPerMTok: 1.5, source: "catalog 2026-11" },
        "c2:z": { inPerMTok: 2, outPerMTok: 8, source: "catalog 2026-11" },
      },
    });
    const { agents } = applyWith(bridge, {
      assignments: [
        { role: "r1", channel: "c1", model: "m" },
        { role: "r2", channel: "c2", model: "v" },
        { role: "r3", channel: "c2", model: "w" },
        { role: "r4", channel: "c2", model: "x" },
        { role: "r5", channel: "c3", model: "sonnet" },
        { role: "r6", channel: "c2", model: "z" },
      ],
    });
    expect(agent(agents, "c1", "m").billing).toBe("free");
    expect(agent(agents, "c1", "m").costs).toBeUndefined();
    expect(agent(agents, "c2", "v").billing).toBe("free");
    const w = agent(agents, "c2", "w");
    expect(w.billing).toBe("priced");
    expect(w.price).toEqual({ inPerMTok: 1.5, outPerMTok: 1.5 });
    expect(agent(agents, "c2", "x").billing).toBe("unmetered");
    const sonnet = agent(agents, "c3", "sonnet");
    expect(sonnet.billing).toBe("reported");
    expect(sonnet.costs).toBe(true);
    const z = agent(agents, "c2", "z");
    expect(z.billing).toBe("priced");
    expect(z.price).toEqual({ inPerMTok: 2, outPerMTok: 8 });
  });

  it("reuses an existing agent and keeps a disabled role's other fields", () => {
    const { bridge } = mk();
    openWizard(
      bridge,
      reply({
        channels: [
          { id: "c1", type: "ollama", enabled: true },
          { id: "c2", type: "openai-compatible", enabled: true },
        ],
        agents: [{ id: "a1", channel: "c1", model: "m", effort: "low" }],
        roles: [
          { id: "worker", enabled: true },
          { id: "helper", enabled: true, agent: "a1", skills: ["s1"], tools: ["WriteFile"] },
        ],
      }),
    );
    driveToReview(bridge, {
      testModels: { c1: ["m"], c2: ["v"] },
      green: [
        { channel: "c1", model: "m" },
        { channel: "c2", model: "v" },
      ],
    });
    const { agents, roles } = applyWith(bridge, {
      assignments: [{ role: "worker", channel: "c1", model: "m" }],
      unfilled: [{ role: "helper", reason: "no fit" }],
    });
    expect(agents).toHaveLength(1);
    expect(agents[0]!.id).toBe("a1");
    expect(agents[0]!.effort).toBe("low");
    const worker = roles.find((r) => r.id === "worker")!;
    expect(worker.agent).toBe("a1");
    expect(worker.enabled).toBe(true);
    const helper = roles.find((r) => r.id === "helper")!;
    expect(helper.enabled).toBe(false);
    expect(helper.agent).toBe("a1");
    expect(helper.skills).toEqual(["s1"]);
    expect(helper.tools).toEqual(["WriteFile"]);
  });

  it("does not restart the probe queue after Back and Next again", () => {
    const { bridge } = mk();
    openWizard(bridge, reply({ channels: [{ id: "c1", type: "ollama", enabled: true }], roles: [] }));
    act(() => bridge.inbound({ type: "channel.test.result", channelId: "c1", ok: true, models: ["m"] }));
    fireEvent.click(screen.getByText("Next: discover models"));
    const starts = () => bridge.sent.filter((m: any) => m.type === "setup.probe.start").length;
    expect(starts()).toBe(1);
    fireEvent.click(screen.getByText("Back"));
    fireEvent.click(screen.getByText("Next: discover models"));
    expect(starts()).toBe(1);
  });

  it("clears the previous recommendation when a rebuild fails", () => {
    const { bridge, store } = mk();
    openWizard(
      bridge,
      reply({
        channels: [{ id: "c1", type: "ollama", enabled: true }],
        roles: [{ id: "r1", enabled: true }],
      }),
    );
    driveToReview(bridge, {
      testModels: { c1: ["m"] },
      green: [{ channel: "c1", model: "m" }],
    });
    act(() =>
      bridge.inbound({
        type: "setup.recommend.result",
        ok: true,
        assignments: [{ role: "r1", channel: "c1", model: "m", reason: "best-fit-model" }],
      }),
    );
    expect(screen.getByText(/best-fit-model/)).toBeTruthy();
    fireEvent.click(screen.getByText("Back"));
    fireEvent.click(screen.getByText("Build proposal"));
    act(() => bridge.inbound({ type: "setup.recommend.result", ok: false, error: "ai exploded" }));
    expect(screen.getByText(/ai exploded/)).toBeTruthy();
    expect(screen.queryByText(/best-fit-model/)).toBeNull();
    expect((screen.getByText("Apply") as HTMLButtonElement).disabled).toBe(true);
    expect(store.state.recommendation).toBeUndefined();
  });

  it("reports a review failure without a token as setupError", () => {
    const { bridge, store } = mk();
    openWizard(
      bridge,
      reply({
        channels: [{ id: "c1", type: "ollama", enabled: true }],
        roles: [{ id: "r1", enabled: true }],
      }),
    );
    driveToReview(bridge, {
      testModels: { c1: ["m"] },
      green: [{ channel: "c1", model: "m" }],
    });
    applyWith(bridge, { assignments: [{ role: "r1", channel: "c1", model: "m" }] });
    act(() => bridge.inbound({ type: "setup.review.result", error: "diff failed" }));
    expect(store.state.setupError).toBe("diff failed");
    expect(bridge.sent.filter((m) => m.type === "setup.approve")).toHaveLength(0);
  });
});
