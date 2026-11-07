import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@stewart/kernel";
import type { RoleDef } from "@stewart/config";
import { matchGlob } from "@stewart/roles-skills";
import { continueQuestion, mapContinueAnswer, parseRecoveryArgs, roleWithScratch, scratchGate, taskScratchDir } from "../src/api.js";

describe("parseRecoveryArgs", () => {
  const lim = { maxSubTasks: 5, ceiling: 60 };
  it("accepts a valid plan", () => {
    const plan = parseRecoveryArgs(
      { subtasks: [{ description: "a", output_file: "o1.txt" }, { description: "b", output_file: "o2.txt", max_turns: 10 }], final_file: "out/f.txt", advice: "be small" },
      lim,
    );
    expect(plan.subtasks).toHaveLength(2);
    expect(plan.subtasks[1].maxTurns).toBe(10);
    expect(plan.finalFile).toBe("out/f.txt");
  });

  it.each([
    [{}, "subtasks"],
    [{ subtasks: [{ description: "a", output_file: "o" }] }, "2..5"],
    [{ subtasks: Array.from({ length: 6 }, (_, i) => ({ description: `d${i}`, output_file: `o${i}` })) }, "2..5"],
    [{ subtasks: [{ description: "a", output_file: "o" }, { description: "b" }] }, "output_file"],
    [{ subtasks: [{ description: "a", output_file: "o" }, { description: "b", output_file: "x/y.txt" }] }, "bare file name"],
    [{ subtasks: [{ description: "a", output_file: "o" }, { description: "b", output_file: "..o.txt" }] }, "bare file name"],
    [{ subtasks: [{ description: "a", output_file: "o" }, { description: "b", output_file: "o2", max_turns: 61 }] }, "max_turns"],
  ])("rejects %j", (args, match) => {
    expect(() => parseRecoveryArgs(args, lim)).toThrow(match as string);
  });
});

describe("continueQuestion", () => {
  const spec = { id: "t1", roleId: "w", title: "t", task: "build the thing", files: [], dependsOn: [] };
  it("recommends Continue when not stuck, Split when stuck, and stays within ~600 chars", () => {
    const free = continueQuestion({ spec, turns: 7, transcript: [], maxActions: 20, canSplit: true });
    expect(free.options[0]).toBe("Continue (+7 turns)");
    expect(free.options).toContain("Split into smaller tasks");
    expect(free.question.length).toBeLessThanOrEqual(600);
    const stuckTx: ChatMessage[] = Array.from({ length: 3 }, (_, i) => [
      { role: "assistant", content: "", toolCalls: [{ id: `c${i}`, name: "ReadFile", arguments: { path: "x" } }] } as ChatMessage,
      { role: "tool", toolCallId: `c${i}`, content: "ok" } as ChatMessage,
    ]).flat();
    const stuck = continueQuestion({ spec, turns: 7, transcript: stuckTx, maxActions: 20, canSplit: true });
    expect(stuck.options[0]).toBe("Split into smaller tasks");
  });

  it("offers only Continue/Stop when split is unavailable", () => {
    const q = continueQuestion({ spec, turns: 3, transcript: [], maxActions: 20, canSplit: false });
    expect(q.options).toEqual(["Continue (+3 turns)", "Stop this task"]);
  });

  it("maps answers", () => {
    expect(mapContinueAnswer("Continue (+3 turns)").kind).toBe("continue");
    expect(mapContinueAnswer("Split into smaller tasks").kind).toBe("split");
    expect(mapContinueAnswer("Stop this task").kind).toBe("stop");
    expect(mapContinueAnswer("try the other file").kind).toBe("text");
  });
});

describe("scratch helpers", () => {
  it("scratchGate approves only inside the task dir", async () => {
    const dir = taskScratchDir("run-1", "t1");
    const calls: string[] = [];
    const gate = scratchGate(dir, async (_c, p) => {
      calls.push(p?.kind === "file" ? p.path : "?");
      return { kind: "approved" };
    });
    const call = { id: "x", name: "WriteFile", arguments: { path: `${dir}/o.txt` } };
    expect((await gate(call, { kind: "file", path: `${dir}/o.txt`, before: null, after: "" }, { roleId: "w", taskId: "t1" })).kind).toBe("approved");
    expect(calls).toHaveLength(0);
    await gate(call, { kind: "file", path: "src/o.txt", before: null, after: "" }, { roleId: "w", taskId: "t1" });
    expect(calls).toEqual(["src/o.txt"]);
  });

  it("roleWithScratch extends non-empty writePaths and leaves unrestricted roles alone", () => {
    const role = (writePaths: string[]): RoleDef =>
      ({ id: "w", enabled: true, skills: [], tools: [], writePaths, turnBudget: 10 }) as RoleDef;
    expect(roleWithScratch(role([]), ".stewart/scratch/r/t").writePaths).toEqual([]);
    const r = roleWithScratch(role(["src/**"]), ".stewart/scratch/r/t");
    expect(matchGlob(".stewart/scratch/r/t/o.txt", ".stewart/scratch/r/t/o.txt")).toBe(true);
    expect(r.writePaths.some((g) => matchGlob(g, ".stewart/scratch/r/t/o.txt"))).toBe(true);
    expect(r.writePaths.some((g) => matchGlob(g, "other/o.txt"))).toBe(false);
  });
});
