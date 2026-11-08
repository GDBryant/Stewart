# Stewart

Cross-IDE AI assistant (v2 rebuild): shared TS core, VS Code + JetBrains hosts, configurable channels/agents/roles/skills.

## Hard Rules
- Always be brief and concise
- Keep `docs/ARCHITECTURE_NOW.md` current: update it in the same commit as any change to modules, run paths, protocol, config or host wiring.

## Commands
- Install deps: `pnpm install`
- Build all: `pnpm -r build`
- Tests: `pnpm -r test`
- Typecheck: `pnpm -r typecheck`
- Module boundaries: `pnpm check:layers` (manifest layers, single `.` export), `pnpm check:boundaries` (core file size), `pnpm check:cycles` (dependency-cruiser), `pnpm check:tsrefs` (tsconfig references; fix with `node scripts/sync-tsrefs.mjs`); all run in CI
- Coverage: `pnpm test:coverage` (per package ≥90% line, ≥80% branch)
- New module: `node scripts/new-module.mjs <name> "<purpose>"`, then add it to `scripts/layers.json` and fill its `README.md`
- JetBrains: `./gradlew test koverVerify buildPlugin`; JCEF e2e: `./gradlew test -Pe2e` (needs display/xvfb)
- Build + install: `./scripts/build-install.sh`

## References
- Architecture now: `docs/ARCHITECTURE_NOW.md` — living description of the code as built (modules, run paths, model facts, gaps). Always kept current.
- Architecture refactoring: `docs/ARCHITECTURE_REFACTORING.md` — R1 model profile + agent-session builder, R2 one run pipeline (direct = single-task run), R3 integrated context compaction; steps, tests, done-when (proposed).
- Plan: `docs/archived_v1/PLAN.md` — architecture, agent levels, milestones, assumptions, open questions.
- Progress: `docs/PROGRESS.md` — milestone status table; update on every milestone commit.
- Compatibility: `docs/COMPATIBILITY.md` — platform matrix, pinned tool versions, verifyPlugin result.
- VS Code feasibility: `docs/archived_v2/VISUAL_STUDIO.md` — target choice (VS Code), portable layers, host mapping, options, phased plan.
- Claude feasibility: `docs/archived_v2/CLAUDE_FEASIBILITY.md` — M1 gate for the Claude Code CLI transport.
- Handoff: `docs/HANDOFF.md` — post-M10 plans for the outstanding items (runIde check, AIF model list, Qwen edits + write verification, Ollama native tools, Visual Studio, Nemotron). Previous handoff text is in git history (`0ee6ce2`).
- Phase 2: `docs/PHASE2.md` — Phase 1 plan/build audit, missing items, and Phase 2 multi-layered agent roadmap (M11–M15).
- Shim parity: `docs/archived_v1/SHIM_PARITY.md` — Python rev, function map, intentional differences, skipped tests.
- Debug logging: `docs/DEBUG_LOGGING.md` — settings, log format, redaction, retention, provider coverage.
- Debug retention plan: `docs/archived_v1/DEBUG_RETENTION_PLAN.md` — outstanding retention gaps and build steps.
- Releasing: `docs/RELEASING.md` — VSIX packaging, per-OS bundled-Node zips, CI/release workflows, secrets-gated signing/publishing.
- Bypass mode plan: `docs/archived_v1/BYPASS_MODE_PLAN.md` — per-category approval bypass, chat/always grants, sub-command matching (implemented).
- Permissions: `docs/PERMISSIONS.md` — categories, effective rule, grant granularity, unparseable constructs, scopes, revoke paths, storage.
- Rename plan: `docs/archived_v1/RENAME_PLAN.md` — AIJB Assistant → Stewart name map, persisted-key migration, steps, verification.
- Chat UX plan: `docs/archived_v1/2026-11-02-chat-ux.md` — right-aligned user bubbles, busy/active-role label, collapsible tool rows, Up/Down prompt recall.
- Images: `docs/IMAGES.md` — image attachments (paste/drop/picker//image), provider wire formats, vision gate, persistence, known gaps.
- Fault recovery spec: `docs/archived_v2/2026-11-04-fault-recovery-design.md` — num_ctx per model, adjustable worker turn budgets, turn-limit continue question, split recovery, scratch dir.
- v2 rebuild architecture: `docs/archived_v2/ARCHITECTURE.md` — shared TS core + JetBrains sidecar, channels/agents/roles/skills, kept vs dropped v1 items.
- Setup wizard: `docs/SETUP.md` — steps, assignment engine, protocol, gaps.
- Fault recovery: `docs/FAULT_RECOVERY.md` — fault kinds, layers 0–2, continue question, scratch dir, settings, limits, log tags.
- Modular design: `docs/MODULAR_DESIGN.md` — layered modules (§3 as-built table), surfaces, health rules, enforcement, migration order (steps 0–7 done, 8 deferred), §11 sketch-vs-build deviations.
- Migration status: `docs/MODULAR_MIGRATION_STATUS.md` — verified state, what each step landed, remaining work (step 8 eslint limits).
- Refactoring: `docs/REFACTORING.md` — healthy-code refactor targets, strategies, behavior-preservation constraints (draft).
- Code health: `docs/2026-11-07-code-health.md` — code-health skill + code-health-reviewer role plan (score / score+issues; Stewart heuristic rubric).
- Budgets + setup info: `docs/BUDGETS_AND_SETUP_INFO.md` — model-aware turn/time profiles (quick/normal/deep), task-size classifier, richer setup-agent inputs (proposed).

## Conventions
- Stack: TypeScript pnpm monorepo (`packages/*` shared, `hosts/*` per-IDE); JetBrains plugin module in Kotlin added at M2.
- Docs live in `docs/`; add a reference here when adding one.
- New code always gets tests for both positive and negative cases.
- Every change ships tests (positive + negative). Coverage target ≥90% line, ≥80% branch; enforced per package by `pnpm test:coverage` in CI.
- New tool-call formats: add to the TS parser with a verbatim fixture test.
