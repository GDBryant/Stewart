# Compatibility

## Declared platform support

| Setting | Value |
|---------|-------|
| Plugin id / name | `com.adb.stewart` / Stewart (vendor ADB; was `com.aijb.assistant` / AIJB Assistant) |
| `since-build` | 251 |
| `until-build` | unset (open) |
| Declared dependency | `com.intellij.modules.platform` only |

## Verified products (`verifyPlugin`)

| IDE | Version |
|-----|---------|
| IntelliJ IDEA Community | 2025.1 |
| PyCharm Professional | 2025.3 |

Result: PASS — Compatible on both IDEs, zero compatibility problems, no internal/experimental API warnings.

## Toolchain (pinned)

| Component | Version |
|-----------|---------|
| JDK | Java 21 (toolchain) |
| Gradle | 9.8.1 (wrapper) |
| Kover | 0.9.9 |
| IntelliJ Platform Gradle Plugin | 2.19.0 |
| Kotlin | 2.2.21 |
| kotlinx-serialization-json | 1.8.1 |
| Compile target | IntelliJ IDEA Community 2025.1 |

## Local toolchain note

The system `java` must be a full JDK (with `javac`). If auto-detection fails, set
`org.gradle.java.installations.paths=<jdk-home>` in `~/.gradle/gradle.properties`
(user-local, not committed). CI uses `actions/setup-java` (temurin 21).

Coverage gate: `check` depends on `koverVerify` (>=90% line, >=80% branch); M8 run: line 96%, branch 81%; still passing at 675 tests (5 live skipped), line 97.1%.

## verifyPlugin

`./gradlew verifyPlugin` — last run after commit `5fe43d3`: IDEA 2025.1 and
PyCharm 2025.3 both Compatible. Re-run on every milestone or platform bump.
To be refreshed after the Stewart rename (new plugin id `com.adb.stewart`, v0.2.0).

## Manual smoke (2026-10-26)

- `./gradlew runIde` (IC 2025.1 sandbox): chat tool window opened, model picker
  populated from the local Ollama container, streaming replies and send/cancel
  worked correctly.
- `scripts/claude-feasibility.sh`: all scripted checks PASS on Claude Code CLI
  2.1.309 (see `docs/CLAUDE_FEASIBILITY.md`); supported CLI version for M3 is
  2.1.309. Managed-policy check 6 passed 2026-10-29 on CLI 2.1.312.

## AIF live check (2026-10-29)

`AifLiveTest` (SHIM and NATIVE tool paths): both passed on `glm-5-3-flash`.
Native is the AIF default; the shim is deprecated and used only for a model
whose tool calls are disabled (`toolPathOverrides["aif/<model>"] = SHIM`).

2026-10-31 follow-up: `GET /models` returns `nemotron-3-embed-8b`,
`qwen3-8-27b`, `glm-5-3-flash` (OpenAI `data[].id` shape). `AifLiveTest`
SHIM and NATIVE passed on `glm-5-3-flash` and `qwen3-8-27b`.
`nemotron-3-embed-8b` is an embedding model — `/chat/completions` returns
HTTP 404 `{"detail":"Not Found"}`, so it is not usable for chat.
Qwen native stream: standard OpenAI deltas, `id` on the first chunk then
null, string `arguments`, `finish_reason: tool_calls`, plus
`reasoning_content` deltas.

2026-10-31 edit-flow check: `AifEditLiveTest` drove a real
`WriteFile` + `EditFile` cycle on `qwen3-8-27b` through preview,
approval and the new post-write read-back check, on both SHIM and
NATIVE paths — the reported Qwen edit incompatibility did **not**
reproduce; approved content `alpha BETA gamma` verified on disk on
both paths. Earlier single-run difference was model behaviour (Qwen
edited the leftover file from the previous run back), not a
protocol or write failure. `EditTool` now re-reads the saved file
and compares it with the approved `FileChange.after`; a mismatch or
missing file is reported as failure with uncertain side effects
rather than success.

## Ollama live check (2026-10-31)

Local Ollama 0.32.15 (`localhost:11434`): `POST /api/show` for `north-mini-code-1.0:latest` returns `completion`/`tools`/`thinking`; `POST /api/chat` with `tools` returns `message.tool_calls[].function.{name, arguments}` (object args, upstream `id` present), `done:true`+`done_reason:"stop"`. Native tools implemented in `OllamaProvider`; localhost `HttpServer` fixture tests cover the protocol, `OllamaToolsE2ETest` covers read→approved edit→approved command end-to-end. Gated `OllamaLiveTest`/`OllamaEditLiveTest` native runs require `OLLAMA_LIVE=1`. 2026-10-31 live run on `north-mini-code-1.0:latest`: all four gated tests passed (models+stream, native tool round trip, shim write/edit, native write/edit).
