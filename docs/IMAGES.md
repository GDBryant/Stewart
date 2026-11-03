# Image attachments

Plan: `docs/superpowers/plans/2026-11-03-image-attachments.md`.

## Spike: Claude CLI image input (Task 1) — PASS

Date 2026-11-03, CLI 2.1.317, `claude-sonnet-5-5`.

`claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages --tools "" --safe-mode --strict-mcp-config --no-session-persistence --disable-slash-commands`
with one stdin line, then EOF:

```json
{"type":"user","message":{"role":"user","content":[
  {"type":"text","text":"..."},
  {"type":"image","source":{"type":"base64","media_type":"image/png","data":"<b64>"}}]}}
```

- Accepted with the existing isolation flags; the 395 KB screenshot was described correctly.
- Output events are the same shape `ClaudeStreamParser` already reads. New `system`/`ui_invalidate` event appears; the parser ignores non-`init` system subtypes and unknown types (`else -> emptyList()`), so no change needed.
- `init` still reports `tools: []`, `mcp_servers: []` (isolation check holds).
- Live test: `CLAUDE_LIVE=1 ./gradlew test --tests '*ClaudeImageLiveTest*'`.
