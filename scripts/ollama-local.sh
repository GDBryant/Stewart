#!/usr/bin/env bash
set -euo pipefail

dir="$(cd "$(dirname "$0")/../docker/ollama" && pwd)"
container="${OLLAMA_CONTAINER:-ollama}"
compose() { docker compose -f "$dir/docker-compose.yml" "$@"; }

running() { docker inspect --format '{{.State.Running}}' "$container" 2>/dev/null | grep -qx true; }

case "${1:-}" in
  up)
    profile="${2:-cpu}"
    case "$profile" in cpu|gpu) ;; *) echo "profile must be cpu or gpu" >&2; exit 2 ;; esac
    compose --profile "$profile" up -d
    ;;
  pull)
    if ! running; then
      echo "Ollama container '$container' is not running. Start it with: $0 up [cpu|gpu]" >&2
      exit 1
    fi
    grep -vE '^\s*(#|$)' "$dir/models.txt" | while read -r model; do
      echo "Pulling $model..."
      docker exec "$container" ollama pull "$model"
    done
    echo
    docker exec "$container" ollama list
    ;;
  webui)
    compose --profile webui up -d open-webui
    echo "Open WebUI: http://localhost:3000"
    ;;
  down)
    compose --profile cpu --profile gpu --profile webui down
    ;;
  *)
    echo "usage: $0 {up [cpu|gpu]|pull|webui|down}" >&2
    exit 2
    ;;
esac
