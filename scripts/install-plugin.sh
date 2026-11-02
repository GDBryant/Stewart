#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
stale="aijb-assistant"  # plugin dir name before the Stewart rename
base="${JETBRAINS_DATA_DIR:-$HOME/.local/share/JetBrains}"

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
    echo "Usage: $0 [--no-build] [IDE_DIR_NAME...]"
    echo "Installs the plugin zip into JetBrains IDE dirs under $base (2025.1+ by default)."
    echo "Removes a stale pre-rename '$stale' plugin dir from each target. PLUGIN_ZIP overrides the zip."
    exit 0
fi

build=1
if [[ "${1:-}" == "--no-build" ]]; then build=0; shift; fi
if (( build )); then (cd "$root" && ./gradlew -q buildPlugin); fi

zip="${PLUGIN_ZIP:-$(ls -t "$root"/build/distributions/*.zip 2>/dev/null | head -1 || true)}"
[[ -n "$zip" ]] || { echo "No plugin zip in build/distributions; run ./gradlew buildPlugin" >&2; exit 1; }
name="$(unzip -Z1 "$zip" | head -1 | cut -d/ -f1)"

targets=()
if (( $# )); then
    for d in "$@"; do targets+=("$base/$d"); done
else
    for d in "$base"/*/; do
        d="${d%/}"
        if [[ "$(basename "$d")" =~ ([0-9]{4})\.([0-9]+)$ ]]; then
            year="${BASH_REMATCH[1]}"; minor="${BASH_REMATCH[2]}"
            if (( year > 2025 || (year == 2025 && minor >= 1) )); then targets+=("$d"); fi
        fi
    done
fi
(( ${#targets[@]} )) || { echo "No JetBrains IDE dirs (2025.1+) found under $base" >&2; exit 1; }

for t in "${targets[@]}"; do
    [[ -d "$t" ]] || { echo "skip (missing): $t" >&2; continue; }
    if [[ "$name" != "$stale" && -d "$t/$stale" ]]; then
        rm -rf "${t:?}/$stale"
        echo "removed stale $stale -> $t"
    fi
    rm -rf "${t:?}/$name"
    unzip -q -o "$zip" -d "$t"
    echo "installed $name -> $t"
done
echo "Restart the IDE(s) to load the plugin."
