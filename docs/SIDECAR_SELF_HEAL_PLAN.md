# JetBrains "Sidecar not running": self-healing Node + late-bootstrap plan

**Status:** complete — M1–M4 built (M3/M4 uncommitted); verified: `./gradlew test` 259/0, webview vitest 267/0, `check:docs`/`check:boundaries`/`check:functions` green
**Date:** 2026-11-25 (state as of `0e5602e` + uncommitted M3 start)
**Goal:** the JetBrains host no longer dead-ends on "Sidecar not running" when no suitable
Node 22 is available: Node resolution is version-checked, self-healing (download + verify +
cache), failures surface as an actionable balloon + webview error with a Restart path, and
panels that load before the sidecar link is up recover when the link later becomes ready.
**Scope:** JetBrains host + webview package only. VS Code host is out of scope.

## Problem (original report)

JetBrains users hit a silent "Sidecar not running": the plugin extracted a bundled sidecar
bundle but, on machines without a bundled runtime, `NodeLocator` accepted *any* `node` on
PATH (even Node < 22) or found none and only `LOG.warn`'d. Panels then failed their `hello`
handshake with no retry path and no actionable message.

## Milestones

| # | Title | State | Check | Commit |
|---|-------|-------|-------|--------|
| M1 | Robust Node 22 discovery (version-checked PATH fallback) | **done** | `./gradlew test --tests "com.adb.stewart.NodeLocatorTest"` | `15066eb` |
| M2 | Self-healing Node download/cache + actionable error | **done** | `./gradlew test` (251/0) | `0e5602e` |
| M3 | Late-bootstrap panel status (`sidecar.ready`) + `STEWART_NODE` override | **done** | `./gradlew test -q && (cd packages/webview && ./node_modules/.bin/vitest run)` | — |
| M4 | Docs, CI packaging guard, version unchanged (3.0.14) | **done** | `pnpm check:docs` green (needs pnpm on PATH) | — |

## M1 (done) — version-checked Node discovery

`NodeLocator` (`hosts/jetbrains/src/main/kotlin/com/adb/stewart/sidecar/NodeLocator.kt`):
bundled `node/<os>-<arch>` first; the PATH fallback now runs a `node --version` probe —
major ≥ 22, timeout-bounded, `probe` seam injectable for tests — instead of accepting any
executable. `NodeLocatorTest` extended with stub executables / injected probes.

## M2 (done) — self-healing runtime + actionable error

- **`sidecar/NodeFetcher.kt`** (new): nodejs.org download of pinned `v22.20.0`
  (tar.gz for linux/darwin, zip for windows), `SHASUMS256.txt` fetch + constant-time
  SHA-256 verify, member extraction into a temp dir, atomic move into the cache
  `<config>/stewart/node/<os-key>/`, progress callback, per-chunk `canceled` polling,
  150 MB archive cap. Existing cache copies short-circuit without any network use.
  `resolveNode()` implements the chain **bundled → cache → PATH (v22+ probe) → download**
  and returns `(node, downloaded)`. `nodeStewartError()` is the shared actionable message.
- **`StewartProjectService.ensureStarted`** (`StewartProjectService.kt`): runs resolution
  inside a cancellable `Task.Backgroundable` (download progress in `indicator.text2`,
  non-modal, never blocks the EDT). Failures push
  `{type:'error', message:'Stewart sidecar failed to start: …'}` to all panels **and** a
  notification balloon with a **Retry** action; unknown platforms get a distinct
  "cannot self-install" message. Canceled downloads are a neutral "start cancelled"
  balloon, not a failure. A self-healed install announces itself ("Stewart installed Node
  22.20.0 (self-heal)") on link-ready.
- **`actions/RestartAction.kt`** (new) + `plugin.xml`: **Tools → "Restart Stewart
  Sidecar"** (`Stewart.Restart`) re-runs the full resolution chain; this is the
  user-facing self-heal trigger referenced by the error messages.
- **`WebviewRouter`**: the `ready` branch does a blocking `hello` with a catch — a failed
  handshake replies `{type:'error', …}` to the panel instead of dead-ending.
- **`scripts/bundle-node.mjs` / `packages/sidecar/test/bundle-node.test.mjs`**: the
  per-OS zip bundling mirrors the same targets as `NodeFetcher` (`TARGETS`/`NodeTarget`
  kept in sync — that's the packaging guarantee M4 asserts in CI).
- Tests: `NodeFetcherTest.kt` (18 tests — SHASUMS parse/verify/mismatch, tar+zip
  extraction, cache short-circuit, cancel, cap), `RestartActionTest.kt`; full suite 251/0;
  `packages/sidecar` vitest 9/9.

## M3 (done) — late-bootstrap recovery + offline override

- `WebviewRouter`: while `linkReady()` (supervisor RUNNING) is false, bootstrap types
  (`ready`, `config.get`, `permissions.bypass`, `slash.list`) are dropped silently — no
  error, no blocking `hello`; other types keep the actionable error.
- `StewartProjectService`: passes `linkReady`; `onLinkReady` pushes `{type:'sidecar.ready'}`
  after `wireLink` (fires on every link-up, so Retry/Restart/crash-restart re-bootstrap too).
- Webview (`stateHandlers.ts`): `sidecar.ready` clears `lastError` and re-posts
  `ready`/`permissions.bypass`/`slash.list`/`config.get`; idempotent, keeps chat state.
- `NodeFetcher.resolveNode`: `STEWART_NODE` env override (first in chain; must probe as Node
  22+, else a clear `NodeFetchException`); error text mentions it.
- Panel-before-start: start is driven by the tool window factory (`ensureStarted`), so
  `ready` need not trigger it.
- Tests: `WebviewRouterTest` (drop while down, non-bootstrap passes), `NodeFetcherTest`
  (override ok / missing / too old), webview `bypass.test.tsx` (3 `sidecar.ready` cases).

## Completeness review (2026-11-25)

| Path to "Sidecar not running" | Covered by |
|---|---|
| No/old Node on PATH, no bundle | M1 + M2 (resolve/download) |
| Download fails (offline/proxy/checksum) | M2 balloon + Retry/Restart + M3 `STEWART_NODE` override |
| Panel opens during start/download, never recovers | M3 `sidecar.ready` |
| Crash loop (DEGRADED) | existing error + Restart action; no auto re-bootstrap after restart (M3 `sidecar.ready` on every `onLinkReady` covers it) |
| Fix not shipped | version stays 3.0.14; needs release by the user |
| Bundled node not executable / macOS quarantine | verified: `chmod 755` in `bundle-node.mjs`, `setExecutable` on extract/fetch; macOS quarantine not tested (no Mac) |

Verdict: all paths covered in code; developers get it once 3.0.14 is released. The update feed
serves the base zip (no bundled Node), so the self-install path is the one most users hit.

## M4 (done) — docs, CI guard, version

ARCHITECTURE_NOW (resolution chain, `sidecar.ready`), RELEASING (packaging guard,
`STEWART_NODE`), `release.yml` zip-content assertions (per-OS zips contain
`node/<os-key>/node(.exe)`; base zip has none), version left at 3.0.14.

## Commands & environment notes (verified)

- Gradle runs from the **repo root** `./gradlew` — `hosts/jetbrains/` has no wrapper.
- JetBrains suite: `./gradlew test` (251 tests, 0 failures at `0e5602e`).
- Webview: `cd packages/webview && ./node_modules/.bin/vitest run`. Sidecar:
  `cd packages/sidecar && ./node_modules/.bin/vitest run` (9/9).
- pnpm lives under `~/.nvm/versions/node/*/bin` — export to PATH before
  `pnpm check:docs` / `pnpm version:set`.
- `docs/investigations/` is intentionally untracked and out of scope for these commits.
- Working tree: M3/M4 changes are uncommitted; `AGENTS.md` and `docs/HARNESS_EFFICIENCY_PLAN.md` are unrelated.
