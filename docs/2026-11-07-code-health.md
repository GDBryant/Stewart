# Code Health Skill + Role Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development (or executing-plans). Steps use `- [ ]`.

**Goal:** Ship a `code-health` skill and a read-only `code-health-reviewer` role. Given code (files, folder, line range, function, or pasted block) the role returns a **score only** or a **score + issues**.

**Architecture:** One entry in `DEFAULT_SKILLS`, one in `DEFAULT_ROLES_YAML`, one `ROLE_PROFILES` entry, one `READONLY_ROLES` entry. Roles merge by id over shipped defaults (`config/loader.ts:71`), so existing installs receive the role (disabled) with no migration. Skill is bundled in the Stewart plugin (shipped defaults), no new tool or protocol.

**Tech Stack:** TypeScript, vitest (`packages/core`).

## Global Constraints
- Brief output; new code gets positive + negative tests (AGENTS.md).
- "Checking" = read-only. No edits, no `RunTerminal`.
- Distinct from `code-review` (diff correctness/security): `code-health` judges structure and maintainability of existing code.
- Score is an **LLM heuristic approximating** CodeScene's Code Health, not the real metric. The skill body must say so.
- Role id stays `code-health-reviewer` (mirrors `code-reviewer`).
- Docs rule: add a reference line to `AGENTS.md`.

## Source: CodeScene AI Playbook 2026 (what it does and does not give us)
Stated by the playbook:
- Code Health = 10-point scale, 25+ code factors; Green/Yellow/Red bands.
- **Green / AI-ready = 9.5+** (ideally 10.0). Defect-risk study covered code ≥7; modules scoring ≤4 are "truly unhealthy".
- Named issues: **high complexity, deep nesting, low cohesion, unstable hotspots**; "too large or complex" functions.
- Guardrails: review continuously while generating → check staged files pre-commit → compare branch vs base pre-PR; loop **Review → Plan → Refactor → Re-measure**; score is the explicit goal; agents "reshuffle complexity" without objective feedback.

NOT stated (Stewart must choose, and label as Stewart-defined): yellow/red cut-offs, per-smell numeric thresholds, deduction weights, aggregation. Unstable hotspots need git history; out of scope for v1 (note only).

## Input handling
There is no structured argument API for skills/roles; scope is resolved by the model from the prompt, using existing read-only tools. Document this; do not imply a new API.

| Input | Resolution (tools) | Limits to state in output |
|---|---|---|
| Files | `ReadFile` each | cross-file coupling/duplication only among opened files |
| Folder | `FindFiles` glob (`dir/**/*.{ts,kt,...}`), skip `node_modules`, `dist`, generated, tests-only unless asked; cap at 20 files, largest/most-changed first, say what was skipped | sampled, not exhaustive |
| File + lines | `ReadFile` with `start_line`/`end_line` | no file-level context; cohesion/coupling not judged |
| File + function | `Search` for the symbol → `ReadFile` the range | as above |
| Code block (inline) | Use as given; no tools | as above; language inferred |

Ambiguous scope (e.g. "check the core") → pick the named folder, state the resolved scope on the first line.

## Modes
- **score** — trigger words: "score only", "just the score", "rating". Output one line per unit scored + aggregate.
- **issues** (default when unspecified: "check", "review", "issues", "score and issues") — score + findings.
- Default rationale: a bare score is not actionable; cost difference is small.

## Scoring rubric (Stewart heuristic)
1. Start each unit (file; or function/block for narrow scopes) at **10.0**.
2. Deduct per finding by severity: high −2.0, med −1.0, low −0.3; cap total deduction per smell category at −4.0; clamp to [1.0, 10.0]; round to 0.1.
3. Bands: **Green ≥ 9.5** (playbook), **Yellow 7.0–9.4**, **Red < 7.0** (yellow/red cut-offs are Stewart's choice, anchored to the playbook's "≥7" study floor).
4. Smell categories and Stewart thresholds (starting points, tune later):

| Smell (playbook term) | Signals | med / high |
|---|---|---|
| High complexity | branches per function; long multi-stage functions | >10 / >15 branches |
| Large units | function length; file length | >60 / >120 lines fn; >500 / >1000 lines file |
| Deep nesting | indent depth in a function | 4 / ≥5 levels |
| Low cohesion | file/class mixing unrelated jobs; many unrelated exports | judgment, evidence required |
| Duplication | same logic repeated (esp. copied tails) | 2 / ≥3 copies |
| Closure/state tangle | many mutable vars captured by nested closures | >4 / >7 captured |
| Dead code | unused exports/params, commented-out blocks | low unless widespread |
| Suppressions / weakened tests | `@ts-ignore`, `eslint-disable`, skipped tests | med |
| Coupling / layering | imports crossing package boundaries | med / high |
| Coverage gap | **only if** a coverage report is provided/readable; otherwise "not checked" | med |
| Unstable hotspots | needs git history | not checked (v1) |

5. **Aggregation** (folder/multi-file): file score per rubric; aggregate = LOC-weighted mean; also report **worst file** and count of Red files. Band of the aggregate is stated, but a Red file is always listed.
6. Narrow scope (lines/function/block): score that unit only and label "unit score — not file health".

## Output contract (testable)
- Line 1: `Scope: <resolved scope> · Mode: <score|issues> · Checked: <n files/lines> · Not checked: <list>`.
- **score mode:** `<unit> — <score>/10 (<Green|Yellow|Red>)` per unit, then `Overall: <score>/10 (<band>)` for multi-unit.
- **issues mode:** the score lines, then one finding per line: `<path:line> | <smell> | <high|med|low> | <suggested refactor>`, ordered by severity. Refactor suggestion names a strategy from `docs/REFACTORING.md` where one fits.
- Healthy code: say so plainly with the score; no filler findings.
- Judge only what was opened. No edits. No claim of running tools not in the role's tool list.

## Files
- Modify `packages/core/src/defaults/skills.ts` — add skill.
- Modify `packages/core/src/defaults/roles.ts` — add role.
- Modify `packages/core/src/assign.ts:46` — `ROLE_PROFILES` entry.
- Modify `packages/core/src/orchestration/orchestrator.ts:29` — `READONLY_ROLES`.
- Modify `packages/core/src/recommend.ts:128` — model-preference prompt text.
- Test `packages/core/test/skills.test.ts`, `roles.test.ts`, `assign.test.ts`.
- Docs: `docs/REFACTORING.md` (Code Health section, done), `docs/PROGRESS.md`, `AGENTS.md`, role lists in `docs/SETUP.md` / `docs/BUDGETS_AND_SETUP_INFO.md` if present.

### Task 1: `code-health` skill

**Interfaces:** Produces skill id `code-health` (version 1) in `DEFAULT_SKILLS`.

- [ ] **Step 1: Failing tests** in `test/skills.test.ts`:
```ts
const body = () => shippedSkill("code-health")!.body;
it("ships code-health with a non-empty body", () => {
  expect(shippedSkill("code-health")).toBeDefined();
  expect(body().length).toBeGreaterThan(50);
});
it("code-health is distinct from code-review", () => {
  expect(body()).not.toBe(shippedSkill("code-review")!.body);
});
it("returns undefined for an unknown skill id", () => {
  expect(shippedSkill("no-such-skill")).toBeUndefined();
});
it("code-health names both modes, the scale and the green threshold", () => {
  for (const s of ["score", "issues", "10", "9.5", "Green", "Yellow", "Red"]) expect(body()).toContain(s);
});
it("code-health covers every input scope", () => {
  for (const s of ["file", "folder", "line", "function", "code block"]) expect(body().toLowerCase()).toContain(s);
});
it("code-health states it is an approximation and read-only", () => {
  expect(body().toLowerCase()).toContain("approximat");
  expect(body().toLowerCase()).toContain("do not edit");
});
it("code-health does not instruct running tools", () => {
  expect(body()).not.toMatch(/run (the )?(tests|terminal|coverage|lint)/i);
});
```
- [ ] **Step 2:** `pnpm --filter ./packages/core test skills` → FAIL.
- [ ] **Step 3:** Insert after `security-review` in `defaults/skills.ts`. Body (condense from sections above; keep < ~2.5k chars):
```ts
  {
    id: "code-health",
    description: "Score code health (0-10) and list maintainability issues for files, a folder, lines, a function or a code block.",
    version: 1,
    body: `Score the health of existing code (not a diff's correctness). Approximates CodeScene Code Health; it is a heuristic, say so once.
Scope: resolve from the request — file(s) via ReadFile; folder via FindFiles (max 20 files, skip node_modules/dist/generated; state what was skipped); file + lines via ReadFile start_line/end_line; function via Search then ReadFile; a pasted code block as given. State the resolved scope.
Mode: "score" if asked for score only; otherwise "issues" (score + findings).
Scoring: each unit starts at 10.0; deduct per finding (high -2.0, med -1.0, low -0.3; max -4.0 per category); clamp 1.0-10.0. Bands: Green >=9.5, Yellow 7.0-9.4, Red <7.0. Folder: LOC-weighted mean, plus worst file and Red-file count. Lines/function/block: label "unit score, not file health".
Smells (with path:line evidence): high complexity (>10 med, >15 high branches), large functions (>60 / >120 lines) and files (>500 / >1000), deep nesting (4 / >=5), low cohesion, duplicated logic, closure-captured mutable state (>4 / >7 vars), dead code, suppressions or skipped/weakened tests, cross-package coupling. Coverage only if a report is readable; hotspots/history not checked.
Output: line 1 "Scope · Mode · Checked · Not checked". Score: "<unit> — <n>/10 (<band>)". Issues: one per line "path:line | smell | high/med/low | refactor", most severe first; name a docs/REFACTORING.md strategy when one fits. Judge only what you opened; snippets cannot show coupling or cross-file duplication. Do not edit files. If healthy, say so.`,
  },
```
- [ ] **Step 4:** Re-run → PASS.
- [ ] **Step 5:** `git add -A && git commit -m "feat: add code-health skill"`

### Task 2: `code-health-reviewer` role

**Interfaces:** Consumes skill `code-health`, `code-search`, `evidence-report`. Produces role id `code-health-reviewer`, read-only, no `RunTerminal` (so no `execution-contract` injection and no id-specific terminal guard needed).

- [ ] **Step 1: Failing tests** in `test/roles.test.ts` (use existing helpers; `shippedRoles` in `skills/skills.ts:60`):
```ts
it("code-health-reviewer ships, disabled, read-only", () => {
  const r = shippedRoleDefs().find((x) => x.id === "code-health-reviewer")!;
  expect(r).toBeDefined();
  expect(r.enabled).toBe(false);
  expect(r.skills).toContain("code-health");
  for (const t of ["WriteFile", "EditFile", "ApplyPatch", "RunTerminal"]) expect(r.tools).not.toContain(t);
});
it("code-health-reviewer has the read tools its input scopes need", () => {
  const r = shippedRoleDefs().find((x) => x.id === "code-health-reviewer")!;
  for (const t of ["ReadFile", "FindFiles", "Search"]) expect(r.tools).toContain(t);
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
      You are the Code Health Reviewer. Score maintainability of the code you
      are given (files, folder, line range, function or pasted block) using the
      code-health skill. Score only if asked; otherwise score and issues. No edits.
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
Plus an orchestrator test (follow the existing `isWriteCapableRole` pattern) asserting `code-health-reviewer` is not write-capable. Negative: `tester` still is.
- [ ] **Step 2:** Run. Orchestrator test may already pass (no `RunTerminal`); keep the `READONLY_ROLES` entry for explicitness and note it.
- [ ] **Step 3:** Apply:
  - `assign.ts`: `"code-health-reviewer": { needs: { tools: true }, minCtx: 16384, wantsReasoning: true },`
  - `orchestrator.ts:29`: add `"code-health-reviewer"` to `READONLY_ROLES`.
  - `recommend.ts:128`: add to the reasoning-model list beside `code-reviewer`.
- [ ] **Step 4:** `pnpm -r test && pnpm -r typecheck` → PASS. Fix any test asserting a role count or id list.
- [ ] **Step 5:** Commit `feat: wire code-health-reviewer into assignment and orchestration`.

### Task 4: Behavior fixtures (skill contract)

Prompt text cannot be unit-tested for model output; test the contract surface we control.
- [ ] Add `packages/core/test/code-health-contract.test.ts`: a pure helper `parseHealthOutput(text)` is **not** shipped in v1 (YAGNI); instead keep a documented golden example in the skill-test file asserting the skill body contains the exact line formats (`path:line | smell | severity | refactor`, `/10 (`). Negative: body lacks "RunTerminal"/"edit the file".
- [ ] Manual smoke (record result in PROGRESS): run the role on (a) one file, score only; (b) `packages/core/src/orchestration`, issues; (c) `ReadFile` lines 83–105 of `tools/builtins.ts`; (d) a pasted block. Expect the output contract in each; unit label on (c)/(d).

### Task 5: Docs

- [ ] `docs/REFACTORING.md`: Code Health section (done in this change).
- [ ] Add reference line to `AGENTS.md`: `- Code health: \`docs/2026-11-07-code-health.md\` — code-health skill + code-health-reviewer role plan (score / score+issues; Stewart heuristic rubric).`
- [ ] Add a row to `docs/PROGRESS.md`; add the role to role lists in `docs/SETUP.md` / `docs/BUDGETS_AND_SETUP_INFO.md` (grep `code-reviewer`).
- [ ] Final: `pnpm -r build && pnpm -r test`; commit `docs: code-health skill and role`.

## Self-review
- Coverage: skill (T1), role (T2), wiring (T3), contract/smoke (T4), docs (T5).
- Input scopes, modes, rubric, aggregation, output contract defined above.
- Existing installs: covered by the merge test in T2.
- Out of scope / later: running lint or coverage (needs `RunTerminal` plus a guard like the investigator's); unstable-hotspot analysis (git history); a fixer role / Review→Plan→Refactor→Re-measure loop automation; pre-commit/PR-gate hooks; calibrating thresholds against real CodeScene scores.
