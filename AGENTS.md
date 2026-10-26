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
- Coverage gate: `./gradlew koverVerify`
- Coverage report: `./gradlew koverHtmlReport` → `build/reports/kover/html/`

## References
- Plan: `docs/PLAN.md` — architecture, agent levels, milestones, assumptions, open questions.
- Compatibility: `docs/COMPATIBILITY.md` — platform matrix, pinned tool versions, verifyPlugin result.
- Claude feasibility: `docs/CLAUDE_FEASIBILITY.md` — M1 gate for the Claude Code CLI transport.

## Conventions
- Stack: Kotlin, Gradle IntelliJ / PyCharm Platform Plugin.
- Docs live in `docs/`; add a reference here when adding one.
- Every change ships tests; `koverVerify` (≥90% line, ≥80% branch) must pass. New code is tested in the same change.
