# AI_Jetbrains_Plugin

JetBrains plugin: chat with Ollama + Claude (enterprise SSO) + AI Factory (built-in tool-call shim), 3-level agent orchestration.

## Hard Rules
- Always be brief and concise

## Commands
- Build plugin: `./gradlew buildPlugin`
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
- Compatibility: `docs/COMPATIBILITY.md` — platform matrix, pinned tool versions, verifyPlugin result.
- Claude feasibility: `docs/CLAUDE_FEASIBILITY.md` — M1 gate for the Claude Code CLI transport.
- Shim parity: `docs/SHIM_PARITY.md` — Python rev, function map, intentional differences, skipped tests.

## Conventions
- Stack: Kotlin, Gradle IntelliJ / PyCharm Platform Plugin.
- Docs live in `docs/`; add a reference here when adding one.
- Every change ships tests; `koverVerify` (≥90% line, ≥80% branch) must pass. New code is tested in the same change.
- New tool-call formats: add to the Kotlin parser with a verbatim test.
