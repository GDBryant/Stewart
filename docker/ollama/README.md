# Local Ollama (Docker)

Runs Ollama in Docker with the two smallest models, for use as a local Stewart `ollama` channel at `http://localhost:11434`.

| Model | Download | Notes |
|---|---:|---|
| `qwen3.5:4b` | ~3.3-4.0 GB | smallest; docs / light coding / chat, 256K ctx |
| `gemma4:e4b` | ~6.6-9.5 GB | chat, vision + audio |

Larger models are commented out in `models.txt`; uncomment to pull them.

```bash
./scripts/ollama-local.sh up         # CPU (default)
./scripts/ollama-local.sh up gpu     # NVIDIA GPU (needs NVIDIA Container Toolkit)
./scripts/ollama-local.sh pull       # pull models listed in models.txt
./scripts/ollama-local.sh webui      # optional Open WebUI on http://localhost:3000
./scripts/ollama-local.sh down
```

Env: `OLLAMA_CONTAINER` (default `ollama`), `WEBUI_SECRET_KEY`.
