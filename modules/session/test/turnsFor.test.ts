import { describe, expect, it } from "vitest";
import type { RoleDef } from "@stewart/config";
import { turnsFor, UNBOUNDED_TURNS } from "../src/taskRun.js";

const role = (turnBudget: RoleDef["turnBudget"]) => ({ turnBudget }) as RoleDef;

describe("turnsFor", () => {
  it("uses the spec budget over the role budget", () => {
    expect(turnsFor({ role: role(25), maxTurns: 60 }, false)).toBe(60);
    expect(turnsFor({ role: role(25) }, false)).toBe(25);
  });

  it("maps a role budget of unlimited to 200", () => {
    expect(turnsFor({ role: role("unlimited") }, false)).toBe(200);
  });

  it("is unbounded at or above UNBOUNDED_TURNS, bounded just below", () => {
    expect(turnsFor({ role: role(25), maxTurns: UNBOUNDED_TURNS - 1 }, false)).toBe(999);
    expect(turnsFor({ role: role(25), maxTurns: UNBOUNDED_TURNS }, false)).toBe(Number.POSITIVE_INFINITY);
    expect(turnsFor({ role: role(5000) }, false)).toBe(Number.POSITIVE_INFINITY);
  });

  it("gives a repair attempt one turn whatever the budget", () => {
    expect(turnsFor({ role: role(25), maxTurns: 5000 }, true)).toBe(1);
  });
});
