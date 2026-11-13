# Stewart

Cross-IDE AI assistant (v2 rebuild): shared TS core, VS Code + JetBrains hosts, configurable channels/agents/roles/skills.

## Hard Rules
- Always be brief and concise
- Keep `docs/ai_docs/ARCHITECTURE_NOW.md` current: update it in the same commit as any change to modules, run paths, protocol, config or host wiring.
- Never push to origin. User will always push to origin.

## Commands
- Install deps: `pnpm install`
- Build all: `pnpm -r build`
- Tests: `pnpm -r test`
- Typecheck: `pnpm -r typecheck`
- Module boundaries: `pnpm check:layers` (manifest layers, single `.` export, per-module dep-count ratchet `scripts/deps.baseline.json`; `--report` lists counts, `--update` accepts), `pnpm check:boundaries` (file size, all packages: >300 warns, >500 fails; `forbidden` pattern rules, e.g. raw `modelCaps` reads), `pnpm check:cycles` (dependency-cruiser), `pnpm check:tsrefs` (tsconfig references; fix with `node scripts/sync-tsrefs.mjs`), `pnpm check:docs` (ARCHITECTURE_NOW version + module table vs code), `pnpm check:functions` (per-function limits: ≤40 code lines, complexity ≤10, depth ≤3, ≤4 params; baseline `scripts/functions.baseline.json` is empty, any offender fails; `--report` lists worst, `--update` drops fixed entries); all run in CI
- Coverage: `pnpm test:coverage` (per package ≥90% line, ≥80% branch)
- pnpm is at `~/.nvm/versions/node/*/bin` (add to PATH); per package alternative: `cd modules/<name>` (or `packages/<name>`) then `./node_modules/.bin/vitest run` (tests), `./node_modules/.bin/tsc -p tsconfig.json --composite false --noEmit` (typecheck), `./node_modules/.bin/tsc -p tsconfig.json` (build). After changing any sidecar dep, re-bundle + repackage: `cd packages/sidecar && ./node_modules/.bin/tsc -p tsconfig.json && ./node_modules/.bin/esbuild src/main.ts --bundle --format=cjs --platform=node --outfile=dist/sidecar.cjs`, then `./gradlew buildPlugin` → `build/distributions/stewart-X.Y.Z.zip`.
- New module: `node scripts/new-module.mjs <name> "<purpose>"`, then add it to `scripts/layers.json` and fill its `README.md`
- JetBrains: `./gradlew test koverVerify buildPlugin`; JCEF e2e: `./gradlew test -Pe2e` (needs display/xvfb)
- Build + install: `./scripts/build-install.sh`

## References

- New design (accepted; steps 0–6 built as v3.0.0; audit and fixes recorded in §8): `docs/NEW_DESIGN_2026-11-13.md` — log evidence of run failures, root causes, and the replacement design: one lead agent per session, engines (native tool loop, Claude Code as full agent), roles as delegated profiles, model chains with escalation, code-run checks, eval-gated build order; §9 design revision built (one task runner, change tracker, code-driven plans, single policy)

`docs/ai_docs/` — living as-built docs:
- Architecture now: `docs/ai_docs/ARCHITECTURE_NOW.md` — living description of the code as built (modules, run paths, model facts, gaps). Always kept current.
- Progress: `docs/ai_docs/PROGRESS.md` — milestone status table; update on every milestone commit.
- Compatibility: `docs/ai_docs/COMPATIBILITY.md` — platform matrix, pinned tool versions, verifyPlugin result.
- Evals: `docs/ai_docs/EVALS.md` — outcome eval suite (`packages/evals`), how to run, recorded pass rates per build step.
- Debug logging: `docs/ai_docs/DEBUG_LOGGING.md` — settings, log format, redaction, retention, provider coverage.
- Images: `docs/ai_docs/IMAGES.md` — image attachments (paste/drop/picker//image), provider wire formats, vision gate, persistence, known gaps.
- Permissions: `docs/ai_docs/PERMISSIONS.md` — categories, effective rule, grant granularity, unparseable constructs, scopes, revoke paths, storage.
- Releasing: `docs/ai_docs/RELEASING.md` — VSIX packaging, per-OS bundled-Node zips, CI/release workflows, secrets-gated signing/publishing.
- Setup wizard: `docs/ai_docs/SETUP.md` — steps, assignment engine, protocol, gaps.
- Health reports: `docs/health_reports/` — dated repository code-health scores and verification results.

`docs/archived_v2/` — superseded or completed v2-era plans and builds:
- Modular design: `docs/archived_v2/MODULAR_DESIGN.md` — layered modules (§3 as-built table), surfaces, health rules, enforcement, migration order (steps 0–8 done), §11 sketch-vs-build deviations.
- Refactoring: `docs/archived_v2/REFACTORING.md` — healthy-code refactor targets, strategies, behavior-preservation constraints, function-limit refactor notes.
- Project health check: `docs/archived_v2/PROJECT_HEALTH_CHECK.md` — orchestrated whole-codebase code-health run (ListCodeFiles inventory, batched reviewer dispatch, submit_health/health_report verbs).
- Architecture refactoring: `docs/archived_v2/ARCHITECTURE_REFACTORING.md` — R1 model profile + agent-session builder, R2 one run pipeline, R3 integrated context compaction.
- Fault recovery: `docs/archived_v2/FAULT_RECOVERY.md` — fault kinds, layers 0–2, continue question, scratch dir, settings, limits, log tags.
- Migration status (done): `docs/archived_v2/MODULAR_MIGRATION_STATUS.md` — verified state and what each §7 step landed; all steps 0–8 complete.
- §11 build (done): `docs/archived_v2/modular-design-refactor-num11.md` — audit, scoping of the §11 deviations, per-item status and commits.
- Architecture improvements (done): `docs/archived_v2/ARCHITECTURE_IMPROVEMENTS.md` — docs check, repo-wide file-size/fan-out gates, `run-contract`/`EffectiveConfig`/`v1-import` ownership, `RunFeature` plugins, `userCaps`/`capsFor` guard, setup-owned channel adds (built; deviations inline).
- Image attachments plan (done): `docs/archived_v2/2026-11-03-image-attachments.md` — implementation plan; as-built in `docs/ai_docs/IMAGES.md`.
- Setup wizard rewrite (done): `docs/archived_v2/2026-11-06-setup-wizard.md` — problem and rewrite plan; as-built in `docs/ai_docs/SETUP.md`.
- Handoff: `docs/archived_v2/HANDOFF.md` — post-M10 plans for the outstanding items (runIde check, AIF model list, Qwen edits + write verification, Ollama native tools, Visual Studio, Nemotron). Previous handoff text is in git history (`0ee6ce2`).
- Phase 2: `docs/archived_v2/PHASE2.md` — Phase 1 plan/build audit, missing items, and Phase 2 multi-layered agent roadmap (M11–M15).
- Code health: `docs/archived_v2/2026-11-07-code-health.md` — code-health skill + code-health-reviewer role plan (score / score+issues; Stewart heuristic rubric).
- Budgets + setup info: `docs/archived_v2/BUDGETS_AND_SETUP_INFO.md` — model-aware turn/time profiles (quick/normal/deep), task-size classifier, richer setup-agent inputs (proposed).
- VS Code feasibility: `docs/archived_v2/VISUAL_STUDIO.md` — target choice (VS Code), portable layers, host mapping, options, phased plan.
- Claude feasibility: `docs/archived_v2/CLAUDE_FEASIBILITY.md` — M1 gate for the Claude Code CLI transport.
- Fault recovery spec: `docs/archived_v2/2026-11-04-fault-recovery-design.md` — num_ctx per model, adjustable worker turn budgets, turn-limit continue question, split recovery, scratch dir.
- v2 rebuild architecture: `docs/archived_v2/ARCHITECTURE.md` — shared TS core + JetBrains sidecar, channels/agents/roles/skills, kept vs dropped v1 items.

`docs/archived_v1/` — v1 archive:
- Plan: `docs/archived_v1/PLAN.md` — architecture, agent levels, milestones, assumptions, open questions.
- Shim parity: `docs/archived_v1/SHIM_PARITY.md` — Python rev, function map, intentional differences, skipped tests.
- Debug retention plan: `docs/archived_v1/DEBUG_RETENTION_PLAN.md` — outstanding retention gaps and build steps.
- Bypass mode plan: `docs/archived_v1/BYPASS_MODE_PLAN.md` — per-category approval bypass, chat/always grants, sub-command matching (implemented).
- Rename plan: `docs/archived_v1/RENAME_PLAN.md` — AIJB Assistant → Stewart name map, persisted-key migration, steps, verification.
- Chat UX plan: `docs/archived_v1/2026-11-02-chat-ux.md` — right-aligned user bubbles, busy/active-role label, collapsible tool rows, Up/Down prompt recall.

## Conventions
- Stack: TypeScript pnpm monorepo (`packages/*` shared, `hosts/*` per-IDE); JetBrains plugin module in Kotlin added at M2.
- Docs live in `docs/`; add a reference here when adding one.
- New code always gets tests for both positive and negative cases.
- Every change ships tests (positive + negative). Coverage target ≥90% line, ≥80% branch; enforced per package by `pnpm test:coverage` in CI.
- New tool-call formats: add to the TS parser with a verbatim fixture test.
