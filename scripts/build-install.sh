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

pnpm install --frozen-lockfile
pnpm -r build

if [ "$SKIP_VSCODE" -eq 0 ]; then
  pnpm --filter ./hosts/vscode run package
  VSIX="$(pwd)/hosts/vscode/stewart.vsix"
  if command -v code >/dev/null 2>&1; then
    code --install-extension "$VSIX" --force
    echo "installed VSIX via code CLI: $VSIX"
  else
    echo "code CLI not found; install manually: code --install-extension $VSIX"
  fi
fi

if [ "$SKIP_JETBRAINS" -eq 0 ]; then
  if [ "$BUNDLE_NODE" -eq 1 ]; then
    node scripts/bundle-node.mjs
  fi
  ./gradlew buildPlugin
  ZIP="$(ls build/distributions/stewart-*.zip | head -1)"
  if [ -n "$JB_PLUGINS_DIR" ]; then
    mkdir -p "$JB_PLUGINS_DIR"
    unzip -oq "$ZIP" -d "$JB_PLUGINS_DIR"
    echo "installed JetBrains plugin to $JB_PLUGINS_DIR (restart the IDE)"
  else
    echo "JetBrains plugin built: $(pwd)/$ZIP"
    echo "install via IDE > Settings > Plugins > gear > Install Plugin from Disk"
  fi
fi
