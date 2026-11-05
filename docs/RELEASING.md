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
