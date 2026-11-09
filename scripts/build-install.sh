#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

SKIP_VSCODE=0
SKIP_JETBRAINS=0
BUNDLE_NODE=0
JB_PLUGINS_DIR=""

while [ $# -gt 0 ]; do
  case "$1" in
    --skip-vscode) SKIP_VSCODE=1 ;;
    --skip-jetbrains) SKIP_JETBRAINS=1 ;;
    --bundle-node) BUNDLE_NODE=1 ;;
    --jetbrains-plugins-dir) JB_PLUGINS_DIR="${2:?--jetbrains-plugins-dir requires a path}"; shift ;;
    *) echo "unknown flag: $1" >&2; exit 2 ;;
  esac
  shift
done

has_build_script() {
  node -e "process.exit(require(\"./$1/package.json\").scripts?.build ? 0 : 1)" 2>/dev/null
}

if command -v pnpm >/dev/null 2>&1; then
  pnpm install --frozen-lockfile
  pnpm -r build
else
  echo "pnpm not found; skipping install (node_modules must already exist)" >&2
  echo "pnpm not found; building workspace packages individually" >&2
  for d in modules/*; do
    [ -f "$d/tsconfig.json" ] || continue
    echo "== tsc -b $d"
    (cd "$d" && ../../node_modules/.bin/tsc -b tsconfig.json)
  done
  for d in packages/protocol packages/core; do
    [ -f "$d/tsconfig.json" ] || continue
    echo "== tsc -b $d"
    (cd "$d" && ../../node_modules/.bin/tsc -b tsconfig.json)
  done
  for d in packages/sidecar packages/webview packages/conformance hosts/vscode; do
    [ -f "$d/package.json" ] || continue
    has_build_script "$d" || continue
    echo "== npm run build $d"
    (cd "$d" && npm run build)
  done
fi

if [ "$SKIP_VSCODE" -eq 0 ]; then
  if command -v pnpm >/dev/null 2>&1; then
    pnpm --filter ./hosts/vscode run package </dev/null
  else
    (cd hosts/vscode && npm run package </dev/null)
  fi
  VSIX="$(pwd)/hosts/vscode/stewart.vsix"
  if command -v code >/dev/null 2>&1; then
    code --install-extension "$VSIX" --force
    echo "installed VSIX via code CLI: $VSIX"
  else
    echo "code CLI not found; install manually: code --install-extension $VSIX"
  fi
fi

if [ "$SKIP_JETBRAINS" -eq 0 ]; then
  [ -f packages/sidecar/dist/sidecar.cjs ] || { echo "packages/sidecar/dist/sidecar.cjs missing; build first" >&2; exit 1; }
  if [ "$BUNDLE_NODE" -eq 1 ]; then
    node scripts/bundle-node.mjs
  fi
  ./gradlew buildPlugin
  ZIP="$(ls -t build/distributions/stewart-*.zip 2>/dev/null | head -1)"
  [ -n "$ZIP" ] || { echo "no plugin zip under build/distributions" >&2; exit 1; }
  if [ -n "$JB_PLUGINS_DIR" ]; then
    mkdir -p "$JB_PLUGINS_DIR"
    unzip -oq "$ZIP" -d "$JB_PLUGINS_DIR"
    echo "installed JetBrains plugin to $JB_PLUGINS_DIR (restart the IDE)"
  else
    echo "JetBrains plugin built: $(pwd)/$ZIP"
    echo "install via IDE > Settings > Plugins > gear > Install Plugin from Disk"
  fi
fi
