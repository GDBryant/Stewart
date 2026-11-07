# Code Health Skill + Role Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development (or executing-plans). Steps use `- [ ]`.

**Goal:** Ship a `code-health` skill and a read-only `code-health-reviewer` role that audit maintainability of a module/repo.

**Architecture:** One entry in `DEFAULT_SKILLS`, one in `DEFAULT_ROLES_YAML`, one `ROLE_PROFILES` entry, one `READONLY_ROLES` entry. Roles merge by id over shipped defaults (`config/loader.ts:71`), so existing installs receive the role (disabled) with no migration.

**Tech Stack:** TypeScript, vitest (`packages/core`).

## Global Constraints
- Brief output; new code gets positive + negative tests (AGENTS.md).
- Assumption: "checking" = read-only. No edits, no `RunTerminal`.
- Distinct from `code-review` (diff correctness/security): `code-health` judges structure and maintainability of existing code.
- Docs rule: add a reference line to `AGENTS.md`.

## Files
- Modify `packages/core/src/defaults/skills.ts` — add skill.
- Modify `packages/core/src/defaults/roles.ts` — add role.
- Modify `packages/core/src/assign.ts:46` — `ROLE_PROFILES` entry.
- Modify `packages/core/src/orchestration/orchestrator.ts:29` — `READONLY_ROLES`.
- Modify `packages/core/src/recommend.ts:128` — model-preference prompt text.
- Test `packages/core/test/skills.test.ts`, `roles.test.ts`, `assign.test.ts`.
- Docs: `docs/PROGRESS.md`, `AGENTS.md`, role lists in `docs/SETUP.md` / `docs/BUDGETS_AND_SETUP_INFO.md` if present.

### Task 1: `code-health` skill

**Interfaces:** Produces skill id `code-health` (version 1) in `DEFAULT_SKILLS`.

- [ ] **Step 1: Failing tests** in `test/skills.test.ts`:
```ts
it("ships code-health with a non-empty body", () => {
  const s = shippedSkill("code-health");
  expect(s).toBeDefined();
  expect(s!.body.length).toBeGreaterThan(50);
});
it("code-health is distinct from code-review", () => {
  expect(shippedSkill("code-health")!.body).not.toBe(shippedSkill("code-review")!.body);
});
it("returns undefined for an unknown skill id", () => {
  expect(shippedSkill("no-such-skill")).toBeUndefined();
});
```
- [ ] **Step 2:** `pnpm --filter ./packages/core test skills` → FAIL (first test).
- [ ] **Step 3:** Insert after `security-review` in `defaults/skills.ts`:
```ts
  {
    id: "code-health",
    description: "Audit maintainability: size, duplication, dead code, coupling, test gaps.",
    version: 1,
    body: `Audit the code's health, not a diff's correctness. Check, with path:line evidence: oversized files and functions, deep nesting and high branching, duplicated logic, dead code and unused exports, layering and coupling violations (imports crossing package boundaries), coverage gaps against the project target (>=90% line, >=80% branch), suppressions and skipped or weakened tests, and drift from project conventions. Judge only what you opened; say what you did not check. Report one finding per line: location, problem, severity (high/med/low), suggested refactor. Order by severity. Do not edit files. If healthy, say so plainly.`,
  },
```
- [ ] **Step 4:** Re-run → PASS.
- [ ] **Step 5:** `git add -A && git commit -m "feat: add code-health skill"`

### Task 2: `code-health-reviewer` role

**Interfaces:** Consumes skill `code-health`, `code-search`, `evidence-report`. Produces role id `code-health-reviewer`, read-only, no `RunTerminal` (so no `execution-contract` injection and no id-specific terminal guard needed).

- [ ] **Step 1: Failing tests** in `test/roles.test.ts` (use existing helpers for parsing shipped roles; `shippedRoles` in `skills/skills.ts:60`):
```ts
it("code-health-reviewer ships, disabled, read-only", () => {
  const r = shippedRoleDefs().find((x) => x.id === "code-health-reviewer")!;
  expect(r).toBeDefined();
  expect(r.enabled).toBe(false);
  expect(r.skills).toContain("code-health");
  for (const t of ["WriteFile", "EditFile", "ApplyPatch", "RunTerminal"]) expect(r.tools).not.toContain(t);
});
it("every shipped role references only shipped skills", () => {
  const ids = new Set(DEFAULT_SKILLS.map((s) => s.id));
  for (const r of shippedRoleDefs()) for (const s of r.skills) expect(ids.has(s), `${r.id}:${s}`).toBe(true);
});
it("existing user roles.yaml still receives the new shipped role", () => {
  const user = stringifyYaml({ version: 1, items: [{ id: "tester", enabled: true }] });
  const cfg = loadConfig({ "roles.yaml": user }, {}, { "roles.yaml": DEFAULT_ROLES_YAML }, true);
  expect(cfg.roles.some((r) => r.id === "code-health-reviewer")).toBe(true);
});
```
Adapt helper/loader names to the file's existing imports; if `shippedRoleDefs` doesn't exist, parse `DEFAULT_ROLES_YAML` with `parseYaml(...).items`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Append to `DEFAULT_ROLES_YAML` after `code-reviewer`:
```yaml
  - id: code-health-reviewer
    enabled: false
    prompt: >-
      You are the Code Health Reviewer. Audit maintainability of the named
      module or repo: size, duplication, dead code, coupling, test gaps. One
      finding per line with path:line, severity, refactor. No edits.
    skills: [code-health, code-search, evidence-report]
    tools: [ReadFile, FindFiles, Search, GetProblems, GetDiff]
```
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat: add code-health-reviewer role`.

### Task 3: Wire into assignment, orchestration, recommendations

- [ ] **Step 1: Failing tests.** `test/assign.test.ts`:
```ts
it("assigns code-health-reviewer to a tool-capable model; unfilled with none", () => {
  expect(scoreAssignments(["code-health-reviewer"], [c("m:30b")]).unfilled).toEqual([]);
  expect(scoreAssignments(["code-health-reviewer"], []).unfilled[0].reason).toBe("no models available");
});
```
Plus an orchestrator test (follow the existing `isWriteCapableRole` test pattern) asserting `code-health-reviewer` is not write-capable. Negative: `tester` still is.
- [ ] **Step 2:** Run → orchestrator test FAILS only if `READONLY_ROLES` matters (no `RunTerminal`, so `isWriteCapableRole` is already false by tools). Keep the `READONLY_ROLES` entry anyway for explicitness; if the test passes pre-change, note that and keep the entry.
- [ ] **Step 3:** Apply:
  - `assign.ts`: `"code-health-reviewer": { needs: { tools: true }, minCtx: 16384, wantsReasoning: true },`
  - `orchestrator.ts:29`: add `"code-health-reviewer"` to `READONLY_ROLES`.
  - `recommend.ts:128`: add `code-health-reviewer` to the reasoning-model list with `code-reviewer`-style roles.
- [ ] **Step 4:** `pnpm -r test && pnpm -r typecheck` → PASS. Fix any test asserting a role count or id list.
- [ ] **Step 5:** Commit `feat: wire code-health-reviewer into assignment and orchestration`.

### Task 4: Docs

- [ ] Add reference line to `AGENTS.md` References: `- Code health: \`docs/2026-11-07-code-health.md\` — code-health skill + code-health-reviewer role plan.`
- [ ] Add a row to `docs/PROGRESS.md`; add the role to role lists in `docs/SETUP.md` / `docs/BUDGETS_AND_SETUP_INFO.md` (grep `code-reviewer`).
- [ ] Final: `pnpm -r build && pnpm -r test`; commit `docs: code-health skill and role`.

## Self-review
- Coverage: skill (T1), role (T2), assignment/orchestration/recommend (T3), docs (T4).
- Existing installs: covered by the merge test in T2.
- Out of scope: running lint/coverage commands (would need `RunTerminal` plus a guard like the investigator's); a fixer role.
