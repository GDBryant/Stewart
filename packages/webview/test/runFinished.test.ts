import { describe, expect, it } from "vitest";
import type { RunEvent } from "@stewart/protocol";
import { finishedItems } from "../src/runFinished.js";
import type { ChatItem } from "../src/stateTypes.js";

type Finished = Extract<RunEvent, { kind: "run.finished" }>;

function ev(p: Partial<Finished> & { status: Finished["status"] }): Finished {
  return { kind: "run.finished", runId: "r1", ...p };
}

function assistant(id = "r1", text = "", streaming = true): ChatItem {
  return { id, role: "assistant", text, streaming, activity: [] };
}

function seq() {
  let n = 0;
  const next = () => n++;
  return { next, calls: () => n };
}

describe("finishedItems", () => {
  it("marks the run item finished on done without outcome", () => {
    const s = seq();
    const items = finishedItems([assistant()], ev({ status: "done" }), s.next);
    expect(items.length).toBe(1);
    expect(items[0].streaming).toBe(false);
    expect(items[0].filesChanged).toBeUndefined();
    expect(s.calls()).toBe(0);
  });

  it("sets filesChanged and appends the outcome line on done with changed files", () => {
    const s = seq();
    const items = finishedItems(
      [assistant()],
      ev({ status: "done", outcome: { changed: ["a.ts", "b.ts"], verified: "none", baseline: "base-1" } }),
      s.next,
    );
    expect(items[0].filesChanged).toEqual(["a.ts", "b.ts"]);
    expect(items[0].filesBaseline).toBe("base-1");
    expect(items.length).toBe(2);
    expect(items[1].role).toBe("system");
    expect(items[1].id).toBe("sys0");
    expect(items[1].text).toBe("Changed 2 files, not verified");
    expect(items[1].revertTurn).toBeUndefined();
    expect(s.calls()).toBe(1);
  });

  it("appends a system item with the error when the last item is not the run item", () => {
    const s = seq();
    const items = finishedItems([assistant("other", "hi", false)], ev({ status: "failed", error: "boom" }), s.next);
    expect(items.length).toBe(2);
    expect(items[1].role).toBe("system");
    expect(items[1].text).toBe("boom");
    expect(s.calls()).toBe(1);
  });

  it("appends a system item with the status when there is no error", () => {
    const s = seq();
    const items = finishedItems([], ev({ status: "cancelled" }), s.next);
    expect(items.length).toBe(1);
    expect(items[0].role).toBe("system");
    expect(items[0].text).toBe("cancelled");
    expect(s.calls()).toBe(1);
  });

  it("fills the run item's empty text with the error", () => {
    const s = seq();
    const items = finishedItems([assistant("r1", "")], ev({ status: "failed", error: "oops" }), s.next);
    expect(items.length).toBe(1);
    expect(items[0].text).toBe("oops");
    expect(items[0].streaming).toBe(false);
    expect(s.calls()).toBe(0);
  });

  it("keeps the run item's existing text on failure", () => {
    const s = seq();
    const items = finishedItems([assistant("r1", "partial")], ev({ status: "failed", error: "oops" }), s.next);
    expect(items[0].text).toBe("partial");
    expect(s.calls()).toBe(0);
  });

  it("appends the outcome item with revertTurn only on failed", () => {
    const failed = finishedItems(
      [assistant()],
      ev({ status: "failed", error: "x", outcome: { changed: ["f.ts"], verified: "files" } }),
      seq().next,
    );
    const outcome = failed[failed.length - 1];
    expect(outcome.revertTurn).toBe(true);
    expect(outcome.text).toBe("Changed 1 file; required files present");

    const done = finishedItems(
      [assistant()],
      ev({ status: "done", outcome: { changed: ["f.ts"], verified: "command", command: "npm test" } }),
      seq().next,
    );
    expect(done[done.length - 1].revertTurn).toBeUndefined();
    expect(done[done.length - 1].text).toBe("Changed 1 file; verified: npm test");
  });

  it("calls nextSeq for the failure item before the outcome item", () => {
    const s = seq();
    const items = finishedItems(
      [],
      ev({ status: "failed", error: "e", outcome: { changed: [], verified: "none" } }),
      s.next,
    );
    expect(items[0].id).toBe("sys0");
    expect(items[1].id).toBe("sys1");
    expect(items[1].text).toBe("No files changed");
    expect(s.calls()).toBe(2);
  });
});
