import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, fireEvent, act } from "@testing-library/preact";
import { BusyNote } from "../src/Busy.js";
import { DoneStep, ReviewStep } from "../src/SetupWizardResult.js";
import { ChannelsStep, DiscoverStep, EvaluatorStep } from "../src/SetupWizardSteps.js";
import { App } from "../src/App.js";
import { Store } from "../src/state.js";
import { MockBridge, type ConfigReply, type SetupProbeSnapshot } from "../src/bridge.js";

afterEach(cleanup);

const noop = () => {};

const roles = [
  { id: "general-worker", enabled: true, agent: "a1" },
  { id: "image-reader", enabled: false },
] as never;

const reviewProps = {
  rec: undefined,
  recommendError: undefined,
  evalMode: "rules" as const,
  bench: false,
  roles,
  eligiblePairs: [{ channel: "c1", model: "m" }],
  rowFor: () => "",
  edits: {},
  probeResults: {},
  onEditRole: noop,
  onApply: noop,
  onBack: noop,
  onUseRules: noop,
};

const rec = {
  assignments: [{ role: "general-worker", channel: "c1", model: "m" }],
  unfilled: [],
};

const counts = { queued: 0, running: 0, green: 0, orange: 0, red: 0, skipped: 0 };

const smokeSnap = (over: Partial<SetupProbeSnapshot>): SetupProbeSnapshot => ({
  status: "done",
  runId: 1,
  ranking: false,
  items: [],
  counts,
  green: [],
  ...over,
});

const discoverProps = {
  smoke: undefined,
  pairs: [{ channel: "c1", model: "m" }],
  probeBusy: false,
  retryable: false,
  bench: false,
  probeResults: {},
  onBench: noop,
  onAccept: noop,
  onRetry: noop,
  onBack: noop,
  onNext: noop,
};

describe("BusyNote", () => {
  it("renders a status region with a spinner and no elapsed under 2s", () => {
    vi.useFakeTimers();
    render(<BusyNote label="Working…" />);
    const el = screen.getByRole("status");
    expect(el.textContent).toContain("Working…");
    expect(el.querySelector(".spinner")).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(1900);
    });
    expect(el.querySelector(".busy-elapsed")).toBeNull();
    vi.useRealTimers();
  });

  it("shows elapsed seconds once 2s have passed and clears the interval on unmount", () => {
    vi.useFakeTimers();
    const { unmount } = render(<BusyNote label="Working…" />);
    act(() => {
      vi.advanceTimersByTime(2100);
    });
    expect(screen.getByRole("status").querySelector(".busy-elapsed")?.textContent).toContain("2s");
    unmount();
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });
});

describe("ReviewStep busy", () => {
  it("shows a rules-mode BusyNote and disables Apply while recommendBusy", () => {
    render(<ReviewStep {...reviewProps} recommendBusy={true} />);
    expect(screen.getByRole("status").textContent).toContain("Matching models to roles…");
    const apply = screen.getByText(/Apply/) as HTMLButtonElement;
    expect(apply.disabled).toBe(true);
    expect(apply.getAttribute("aria-busy")).toBe("true");
    expect(apply.querySelector(".spinner")).toBeTruthy();
  });

  it("shows the AI-mode label while recommendBusy", () => {
    render(<ReviewStep {...reviewProps} evalMode="ai" recommendBusy={true} />);
    expect(screen.getByRole("status").textContent).toContain("AI evaluator is refining the proposal");
  });

  it("shows the bench label while recommendBusy and bench on", () => {
    render(<ReviewStep {...reviewProps} evalMode="ai" bench={true} recommendBusy={true} />);
    expect(screen.getByRole("status").textContent).toContain("Measuring model speed and building the proposal");
  });

  it("shows no busy note and enables Apply when a recommendation is present", () => {
    render(<ReviewStep {...reviewProps} rec={rec as never} recommendBusy={false} />);
    expect(document.querySelector(".busy")).toBeNull();
    expect((screen.getByText("Apply") as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("EvaluatorStep busy", () => {
  const props = {
    evalMode: "rules" as const,
    onEvalMode: noop,
    eligiblePairs: [{ channel: "c1", model: "m" }],
    evaluator: "",
    evalSel: "c1:m",
    onEvaluator: noop,
    priorities: { speed: 2, cost: 2, quality: 2 },
    onPriorities: noop,
    typicalWork: "",
    onTypicalWork: noop,
    onBuild: noop,
    onBack: noop,
  };

  it("disables Build proposal with a spinner while busy", () => {
    render(<EvaluatorStep {...props} busy={true} />);
    const btn = screen.getByText(/Building…/) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.getAttribute("aria-busy")).toBe("true");
    expect(btn.querySelector(".spinner")).toBeTruthy();
  });

  it("keeps Build proposal enabled when not busy", () => {
    render(<EvaluatorStep {...props} />);
    const btn = screen.getByText("Build proposal") as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
  });
});

describe("DoneStep", () => {
  it("shows a saving BusyNote and no Undo while setupSaved is undefined", () => {
    render(<DoneStep setupSaved={undefined} setupError={undefined} onUndo={noop} onFinish={noop} />);
    expect(screen.getByRole("status").textContent).toContain("Saving configuration…");
    expect(screen.queryByText("Undo")).toBeNull();
    expect((screen.getByText("Finish") as HTMLButtonElement).disabled).toBe(false);
  });

  it("shows Setup complete and Undo once saved", () => {
    render(<DoneStep setupSaved={true} setupError={undefined} onUndo={noop} onFinish={noop} />);
    expect(screen.getByText(/Setup complete/)).toBeTruthy();
    expect(screen.getByText("Undo")).toBeTruthy();
  });

  it("shows Save failed when a review error set setupError with setupSaved undefined", () => {
    render(<DoneStep setupSaved={undefined} setupError="no token" onUndo={noop} onFinish={noop} />);
    expect(screen.getByText(/Save failed/)).toBeTruthy();
    expect(screen.queryByText(/Setup complete/)).toBeNull();
    expect(document.querySelector(".busy")).toBeNull();
  });

  it("fires onUndo once and latches the Undo button", () => {
    const onUndo = vi.fn();
    render(<DoneStep setupSaved={true} setupError={undefined} onUndo={onUndo} onFinish={noop} />);
    const btn = screen.getByText("Undo") as HTMLButtonElement;
    fireEvent.click(btn);
    expect(onUndo).toHaveBeenCalledTimes(1);
    expect(btn.disabled).toBe(true);
    expect(btn.getAttribute("aria-busy")).toBe("true");
    fireEvent.click(btn);
    expect(onUndo).toHaveBeenCalledTimes(1);
  });
});

describe("DiscoverStep busy", () => {
  it("shows a spinner on the running row", () => {
    render(
      <DiscoverStep
        {...discoverProps}
        smoke={smokeSnap({ status: "running", items: [{ channel: "c1", model: "m", state: "running" }], counts: { ...counts, running: 1 } })}
      />,
    );
    expect(document.querySelectorAll(".spinner").length).toBeGreaterThan(0);
    expect(screen.getByText(/probing…/)).toBeTruthy();
  });

  it("shows Starting model discovery while probeBusy before smoke runs", () => {
    render(<DiscoverStep {...discoverProps} probeBusy={true} />);
    expect(screen.getByRole("status").textContent).toContain("Starting model discovery…");
  });

  it("counts done items while smoke is running", () => {
    render(
      <DiscoverStep
        {...discoverProps}
        probeBusy={true}
        smoke={smokeSnap({
          status: "running",
          items: [
            { channel: "c1", model: "m", state: "green" },
            { channel: "c1", model: "x", state: "red" },
            { channel: "c1", model: "y", state: "running" },
          ],
        })}
      />,
    );
    expect(screen.getByRole("status").textContent).toContain("Smoke-testing models (2 of 3 done)…");
  });

  it("shows a BusyNote while ranking", () => {
    render(<DiscoverStep {...discoverProps} smoke={smokeSnap({ status: "running", ranking: true, items: [] })} />);
    const notes = [...document.querySelectorAll(".busy")].map((n) => n.textContent);
    expect(notes.some((t) => t?.includes("Ranking remaining models…"))).toBe(true);
  });

  it("Retry failed latches until the probe reports running", () => {
    const onRetry = vi.fn();
    const done = smokeSnap({
      status: "done",
      items: [{ channel: "c1", model: "m", state: "red", reason: "boom" }],
      counts: { ...counts, red: 1 },
    });
    const { rerender } = render(<DiscoverStep {...discoverProps} retryable={true} smoke={done} onRetry={onRetry} />);
    const btn = screen.getByText("Retry failed") as HTMLButtonElement;
    fireEvent.click(btn);
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(btn.disabled).toBe(true);
    expect(screen.getByText(/Retrying…/)).toBeTruthy();
    rerender(
      <DiscoverStep
        {...discoverProps}
        retryable={true}
        smoke={smokeSnap({ status: "running", runId: 2, items: [{ channel: "c1", model: "m", state: "running" }] })}
        onRetry={onRetry}
      />,
    );
    rerender(<DiscoverStep {...discoverProps} retryable={true} smoke={smokeSnap({ status: "done", runId: 2 })} onRetry={onRetry} />);
    const again = screen.getByText("Retry failed") as HTMLButtonElement;
    expect(again.disabled).toBe(false);
  });
});

describe("ChannelStatusRow retest latch", () => {
  const channelProps = (store: unknown, statusChannels: { id: string; type: string; enabled: boolean }[], tests: Record<string, unknown>) => ({
    store: store as never,
    hasChannels: true,
    source: "existing" as const,
    onSource: noop,
    preset: { label: "Ollama", help: "", type: "ollama", needsKey: false } as never,
    chId: "",
    baseUrl: "",
    apiKey: "",
    onPickPreset: noop,
    onChId: noop,
    onBaseUrl: noop,
    onApiKey: noop,
    onAddChannel: noop,
    statusChannels: statusChannels as never,
    tests: tests as never,
    evalChannels: [],
    evalChan: "",
    evalChanObj: undefined,
    evalAgents: [],
    evalOptions: [],
    evalSel: "",
    onEvalChannel: noop,
    onEvaluator: noop,
    nextDisabled: false,
    onBack: noop,
    onNext: noop,
  });

  it("shows a spinner while testing and latches Retest until a new result arrives", () => {
    const store = { testChannel: vi.fn() };
    const channels = [{ id: "c1", type: "ollama", enabled: true }];
    const { rerender } = render(<ChannelsStep {...channelProps(store, channels, {})} />);
    expect(document.querySelector(".spinner")).toBeTruthy();
    expect(screen.getByText(/testing…/)).toBeTruthy();
    const btn = screen.getByText("Retest") as HTMLButtonElement;
    fireEvent.click(btn);
    expect(store.testChannel).toHaveBeenCalledWith("c1");
    expect(btn.disabled).toBe(true);
    expect(btn.getAttribute("aria-busy")).toBe("true");
    rerender(<ChannelsStep {...channelProps(store, channels, { c1: { ok: true, models: ["m"] } })} />);
    const again = screen.getByText("Retest") as HTMLButtonElement;
    expect(again.disabled).toBe(false);
    expect(screen.getByText(/✓ 1 models/)).toBeTruthy();
  });
});

describe("Add channel latch", () => {
  const configReply: { type: "config" } & ConfigReply = {
    type: "config" as const,
    files: { "channels.yaml": "version: 1\nitems: []\n" },
    summary: {
      channels: [{ id: "c1", type: "ollama", enabled: true, baseUrl: "http://x" }],
      agents: [{ id: "a1", channel: "c1", model: "m" }],
      roles: [],
      skills: [],
      settings: {},
    },
    errors: [],
  };

  it("disables Add this channel until the new channel shows up, then re-enables", () => {
    const bridge = new MockBridge();
    const store = new Store(bridge);
    render(<App store={store} />);
    fireEvent.click(screen.getAllByText("Settings")[0]);
    act(() => bridge.inbound(configReply));
    fireEvent.click(screen.getByText("Run setup"));
    fireEvent.click(screen.getByText("Start"));
    fireEvent.click(screen.getByLabelText("source new"));
    const btn = screen.getByText("Add this channel") as HTMLButtonElement;
    fireEvent.click(btn);
    expect(btn.disabled).toBe(true);
    expect(btn.getAttribute("aria-busy")).toBe("true");
    expect(screen.getByText(/Adding…/)).toBeTruthy();
    act(() =>
      bridge.inbound({
        ...configReply,
        summary: {
          ...configReply.summary,
          channels: [...configReply.summary.channels, { id: "local-ollama", type: "ollama", enabled: true, baseUrl: "http://localhost:11434" }],
        },
      } as typeof configReply),
    );
    const again = screen.getByText("Add this channel") as HTMLButtonElement;
    expect(again.disabled).toBe(false);
    expect(again.getAttribute("aria-busy")).toBeNull();
  });
});
