# Compatibility

## Declared platform support

| Setting | Value |
|---------|-------|
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

Coverage gate: `check` depends on `koverVerify` (>=90% line, >=80% branch); M8 run: line 96%, branch 81%; still passing at 591 tests (4 live skipped).

## verifyPlugin

`./gradlew verifyPlugin` — last run after commit `22eefc8`: IDEA 2025.1 and
PyCharm 2025.3 both Compatible. Re-run on every milestone or platform bump.

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
