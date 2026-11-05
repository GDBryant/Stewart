# Releasing

Artifacts produced per release:

- `hosts/vscode/stewart.vsix` — VS Code extension (webview + core bundled by esbuild; `--no-dependencies`, workspace deps are compiled in).
- `build/distributions/stewart-<version>.zip` — JetBrains plugin, system-Node fallback.
- `stewart-<version>-<os>-<arch>.zip` — JetBrains plugin with a bundled Node 22 runtime for one platform (`linux-x64`, `linux-arm64`, `macos-x64`, `macos-arm64`, `windows-x64`).

## Local builds

```bash
pnpm install && pnpm -r build
pnpm --filter stewart run package        # -> hosts/vscode/stewart.vsix
./gradlew buildPlugin                   # -> build/distributions/stewart-<version>.zip
```

### Bundled-Node variants

```bash
node scripts/bundle-node.mjs linux-x64      # one platform; no args = all five
./gradlew buildPlugin
```

`scripts/bundle-node.mjs` downloads the official Node 22 archive plus
`SHASUMS256.txt` from nodejs.org, verifies the SHA-256 before extraction, and
stages the binary at `dist/node/<os>-<arch>/`. Gradle's `syncNode` copies it into
the plugin jar at `node/<os>-<arch>/`; `WebviewResources.extractSidecar`
extracts the host-platform binary at runtime and `NodeLocator` prefers it over
`node` on PATH. Repeat the download+`buildPlugin` loop per platform for each
variant zip; the base zip is built with `dist/node` absent.

## CI

- `.github/workflows/ci.yml` — on push/PR: pnpm build/typecheck/test, VSIX package, Gradle `test koverVerify buildPlugin`.
- `.github/workflows/release.yml` — on tag `v*`: builds the VSIX and all JetBrains variants, then `gh release create` attaching every artifact.

## Signing and publishing (secrets-gated)

All secrets are optional; steps are skipped when unset. Never commit credentials.

| Secret | Use |
|--------|-----|
| `VSCE_PAT` | `vsce publish` of the VSIX to the marketplace |
| `CERTIFICATE_CHAIN` + `PRIVATE_KEY` (+ optional `PRIVATE_KEY_PASSWORD`) | `./gradlew signPlugin` signing of the JetBrains zip; read via env vars in `build.gradle.kts` `intellijPlatform.signing` |

Signing also works locally: export the same env vars and run `./gradlew signPlugin`.

## One-command build + install

```bash
scripts/build-install.sh [--skip-vscode] [--skip-jetbrains] [--bundle-node] [--jetbrains-plugins-dir <path>]
```

Runs `pnpm install --frozen-lockfile`, `pnpm -r build`, packages the VSIX and
the JetBrains zip, installs the VSIX via `code --install-extension --force`
when the `code` CLI exists, and unzips the JetBrains plugin into
`--jetbrains-plugins-dir` (otherwise prints the install-from-disk path).
`--bundle-node` runs `scripts/bundle-node.mjs` first so the zip ships all five
bundled Node runtimes.

## Releases and auto-update

- Single version source: git tag `vX.Y.Z` (prerelease suffixes like `-rc1` allowed). `release.yml` derives `VERSION` from the tag, passes `-Pversion=$VERSION` to `buildPlugin` (build.gradle.kts honors `-Pversion`, default `2.0.0`) and the version arg to `vsce package` (plain `major.minor.patch`; prerelease tags package the numeric part with `--pre-release` and skip marketplace publish). A step fails the job if `plugin.xml`/VSIX `package.json` versions differ from the tag.
- JetBrains update feed: `scripts/gen-update-feed.mjs <version>` writes `updatePlugins.xml` pointing at the BASE zip (system-Node fallback) at `releases/download/v<version>/stewart-<version>.zip`. On non-prerelease tags the workflow uploads it to GitHub Pages and attaches it as a release asset: `https://gdbryant.github.io/Stewart/updatePlugins.xml`. Per-OS bundled-Node zips (`stewart-<v>-<os>-<arch>.zip`) are manual downloads — not advertised by the feed.
- User install via the feed: IDE → Settings → Plugins → gear → Manage Plugin Repositories → `+` → `https://gdbryant.github.io/Stewart/updatePlugins.xml` → OK → install/update Stewart.
- One-time maintainer setup: repo Settings → Pages → Source: GitHub Actions; create a VS Code Marketplace publisher and add the `VSCE_PAT` secret (`hosts/vscode/package.json` `publisher: "stewart"` must be changed to the real publisher id — confirm before the first marketplace publish); `CERTIFICATE_CHAIN`/`PRIVATE_KEY`(/`PRIVATE_KEY_PASSWORD`) are optional for `signPlugin`.
