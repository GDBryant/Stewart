# Stewart

JetBrains plugin: chat with Ollama + Claude (enterprise SSO) + AI Factory (native tools; deprecated tool-call shim kept as per-model fallback), 3-level agent orchestration.

## Hard Rules
- Always be brief and concise

## Commands
- Build plugin: `./gradlew buildPlugin`
- Install into local IDEs (2025.1+): `scripts/install-plugin.sh [--no-build] [IDE_DIR_NAME...]`; or IDE → Settings → Plugins → ⚙ → Install Plugin from Disk → `build/distributions/stewart-<ver>.zip`
- Tests: `./gradlew test`
- Plugin Verifier: `./gradlew verifyPlugin`
- Run IDE sandbox: `./gradlew runIde`
- Live Ollama smoke test (skipped by default): `OLLAMA_LIVE=1 ./gradlew test --tests '*OllamaLiveTest*'`
- Live AIF test (skipped, needs env): `AIF_LIVE=1 AIF_BASE_URL=... AIF_API_KEY=... AIF_MODEL=... ./gradlew test --tests '*AifLiveTest*'`
- Live Claude test (skipped, needs env): `CLAUDE_LIVE=1 ./gradlew test --tests '*ClaudeLiveTest*'` (uses the enterprise CLI login)
- Coverage gate: `./gradlew koverVerify`
- Coverage report: `./gradlew koverHtmlReport` → `build/reports/kover/html/`

## References
- Plan: `docs/PLAN.md` — architecture, agent levels, milestones, assumptions, open questions.
- Progress: `docs/PROGRESS.md` — milestone status table; update on every milestone commit.
- Compatibility: `docs/COMPATIBILITY.md` — platform matrix, pinned tool versions, verifyPlugin result.
- VS Code feasibility: `docs/VISUAL_STUDIO.md` — target choice (VS Code), portable layers, host mapping, options, phased plan.
- Claude feasibility: `docs/CLAUDE_FEASIBILITY.md` — M1 gate for the Claude Code CLI transport.
- Handoff: `docs/HANDOFF.md` — post-M10 plans for the outstanding items (runIde check, AIF model list, Qwen edits + write verification, Ollama native tools, Visual Studio, Nemotron). Previous handoff text is in git history (`0ee6ce2`).
- Phase 2: `docs/PHASE2.md` — Phase 1 plan/build audit, missing items, and Phase 2 multi-layered agent roadmap (M11–M15).
- Shim parity: `docs/SHIM_PARITY.md` — Python rev, function map, intentional differences, skipped tests.
- Debug logging: `docs/DEBUG_LOGGING.md` — settings, log format, redaction, retention, provider coverage.
- Debug retention plan: `docs/DEBUG_RETENTION_PLAN.md` — outstanding retention gaps and build steps.
- Bypass mode plan: `docs/BYPASS_MODE_PLAN.md` — per-category approval bypass, chat/always grants, sub-command matching (implemented).
- Permissions: `docs/PERMISSIONS.md` — categories, effective rule, grant granularity, unparseable constructs, scopes, revoke paths, storage.
- Rename plan: `docs/RENAME_PLAN.md` — AIJB Assistant → Stewart name map, persisted-key migration, steps, verification.
- Chat UX plan: `docs/superpowers/plans/2026-11-02-chat-ux.md` — right-aligned user bubbles, busy/active-role label, collapsible tool rows, Up/Down prompt recall.
- Images: `docs/IMAGES.md` — image attachments (paste/drop/picker//image), provider wire formats, vision gate, persistence, known gaps.
- Fault recovery spec: `docs/superpowers/specs/2026-11-04-fault-recovery-design.md` — num_ctx per model, adjustable worker turn budgets, turn-limit continue question, split recovery, scratch dir.
- Fault recovery: `docs/FAULT_RECOVERY.md` — fault kinds, layers 0–2, continue question, scratch dir, settings, limits, log tags.

## Conventions
- Stack: Kotlin, Gradle IntelliJ / PyCharm Platform Plugin.
- Docs live in `docs/`; add a reference here when adding one.
- New code always gets tests for both positive and negative cases.
- Every change ships tests; `koverVerify` (≥90% line, ≥80% branch) must pass. New code is tested in the same change.
- New tool-call formats: add to the Kotlin parser with a verbatim test.
