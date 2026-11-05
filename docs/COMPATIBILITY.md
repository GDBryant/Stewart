# Compatibility

## Declared platform support

| Setting | Value |
|---------|-------|
| Plugin id / name | `com.adb.stewart` / Stewart (vendor ADB; was `com.aijb.assistant` / AIJB Assistant) |
| `since-build` | 261 |
| `until-build` | unset (open) |
| Declared dependency | `com.intellij.modules.platform` only |

## Verified products (`verifyPlugin`)

| IDE | Version |
|-----|---------|
| IntelliJ IDEA Community | 2026.1 |
| PyCharm Professional | 2026.2 |

Baseline moved to 2026.1+ (`since-build 261`); 2025.x products are no longer supported or verified. **2026 re-verification (M9): PASS — Compatible on IU-261.22158.277 + PY-262.8665.309** (4 deprecated + 6 experimental + 1 internal API usages, accepted; `failureLevel = COMPATIBILITY_PROBLEMS`; reports under `build/reports/pluginVerifier/`). `runIde` smoke: IDE booted, `Loaded custom plugins: Stewart (2.0.0)`, no plugin-load errors (`log_runIde/idea.log`); sidecar starts on tool-window open. Historical M2 result: PASS — Compatible on IC 2025.1 + PY 2025.3, zero compatibility problems. Internal/experimental/deprecated API usages are reported but accepted (see verifyPlugin below); `failureLevel` is set to `COMPATIBILITY_PROBLEMS` only.

## Toolchain (pinned)

| Component | Version |
|-----------|---------|
| JDK | Java 21 (toolchain) |
| Gradle | 9.8.1 (wrapper) |
| Kover | 0.9.9 |
| IntelliJ Platform Gradle Plugin | 2.19.0 |
| Kotlin | 2.2.21 |
| kotlinx-serialization-json | 1.8.1 |
| Compile target | IntelliJ IDEA Community 2026.1 |

## Local toolchain note

The system `java` must be a full JDK (with `javac`). If auto-detection fails, set
`org.gradle.java.installations.paths=<jdk-home>` in `~/.gradle/gradle.properties`
(user-local, not committed). CI uses `actions/setup-java` (temurin 21).

Coverage gate: `check` depends on `koverVerify` (>=90% line, >=80% branch); M2 run: 61 tests, gate passing. JCEF/tool-window/service glue is excluded from Kover (not exercisable headless); logic lives in `SidecarWiring`/`WebviewRouter`/`host.*`.

## verifyPlugin

`./gradlew verifyPlugin` — targets IDEA Community 2026.1 and PyCharm 2026.2.
Last run at M2 against the previous baseline (v2 plugin `com.adb.stewart` 2.0.0):
IDEA Community 2025.1 and PyCharm 2025.3 both **Compatible**, zero compatibility
problems. `VerifyPluginTask.failureLevel` = `COMPATIBILITY_PROBLEMS` only; the
verifier still reports accepted usages: internal
`TrustedProjects`/`TrustedProjectsLocator` (no public trust-state API existed at
the M2 platform level; re-check on 2026.1) and Kotlin-generated overrides of
`ToolWindowFactory` default methods (`getIcon`/`getAnchor`/`manage`/
`isApplicable`/`isDoNotActivateOnStart`) — unavoidable for any Kotlin
`ToolWindowFactory`. Re-run on every milestone or platform bump.

## Manual smoke (2026-10-26, pre-baseline-bump)

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
`reasoning_content` deltas. Reasoning chunks omit `content`; every
`tool_calls` chunk sends `"content":null` (2026-11-02 live capture). That
JSON null was once rendered as the text `"null"` — `AifProvider` now treats
only string `content` as text.

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

## Ollama `num_ctx` and VRAM

Settings > Ollama context window (`model=tokens`) sends `options.num_ctx` per model; without an entry the server default applies. The KV cache grows with `num_ctx`, so a larger window uses more VRAM (and spills to slower CPU/RAM when it no longer fits). Raise it only as far as the GPU allows.

## Packaging (M9)

- VSIX: `pnpm --filter stewart run package` (vsce `--no-dependencies`; webview + core esbuild-bundled). Verified contents: `package.json`, `out/extension.js`, `webview/webview.{js,css}` only.
- JetBrains zip: `./gradlew buildPlugin` → `stewart-<version>.zip`; contains `sidecar/sidecar.cjs`, `webview/`, plugin jar, serialization jars; falls back to `node` on PATH.
- Bundled-Node variants: `node scripts/bundle-node.mjs <key>` (linux-x64 verified; downloads official archives with SHASUMS256 verification) then `buildPlugin`. Verified linux-x64 zip contains `node/linux-x64/node` (Node v22.20.0, executable). Signing via `CERTIFICATE_CHAIN`/`PRIVATE_KEY`/`PRIVATE_KEY_PASSWORD` env → `signPlugin` (unsigned/unverified in CI without secrets).
