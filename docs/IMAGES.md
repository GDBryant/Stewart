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

## Input routes

All routes build an `ImageAttachment` (`chat/ImageAttachment.kt`) via `ImageLoader` and add it to the pending strip above the input. Remove a pending image from the strip before sending.

- Paste: image clipboard in the input or chat area (`ui/ImageTransferHandler.kt`). Image plus text clipboard pastes as text (known gap).
- Drop: image files, `javaFileListFlavor` or `text/uri-list` (Wayland/file managers).
- 📎 button: file chooser filtered to the extensions below (`ChatPanel.chooseImage`).
- `/image <path>`: relative paths resolve against the project root (`chat/SlashCommands.kt`).

## Limits (`chat/ImageLimits.kt`)

- 5 MB per image after normalisation (`MAX_BYTES`); 50 MB read cap before decode.
- Longest edge 1568 px (`MAX_EDGE`); larger images are downscaled to PNG.
- 5 images per message (`MAX_PER_MESSAGE`).
- Extensions: png, jpg, jpeg, gif, webp. webp is accepted by extension but may fail to decode on this JDK (clear error shown).
- GIF is sent unmodified when within limits; only the first frame is decoded for size checks.

## Wire format

- Ollama: `images` array on the message, raw base64 (no data-URL prefix).
- AIF: `content` array of `text` (omitted when blank) and `image_url` parts with data URLs. Messages without images keep plain string `content`.
- Claude CLI: `--input-format stream-json` is added only when the last user message has images. That message becomes one stdin line with `text` (omitted when blank) and `image` blocks. Earlier-turn images become `[image: name]` text.

## Vision gate

- Ollama: `vision` in model capabilities (`/api/tags`, else `/api/show`); unknown means no images.
- Claude: all models.
- AIF: name heuristic `AifVision.NAME_HINTS` (letter-boundary match), plus the Settings "Vision models" override stored as `aif/<id>`.
- Multi-model mode checks the planner model. A blocked send keeps the attachments and shows a status message.

## Persistence

- Files: `<systemDir>/stewart/history/<projectHash>-images/<sha256>.<ext>` beside the chat JSON (`ChatHistoryStore`). JSON stores name, media type and file name only.
- Written atomically and deduplicated by hash. Unreferenced files are removed on every save.
- History retention (`retentionDays`) applies: expired or disabled history deletes the chat and its images. Clear deletes the image folder. Orphan `-images` folders are swept on prune.

## Token accounting and compaction

- Each image counts 1500 tokens (`TokenEstimate.IMAGE_TOKENS`).
- Compaction: the summary input shows `[image: name]` for each image. The first kept user message keeps its images. Images in summarised-away messages are dropped and their files removed on save.

## Debug log

- Logs carry placeholders such as `[image png 123KB]`, never base64. Ollama and AIF payloads are redacted (`redactImages`); Claude logs text plus placeholders.

## Known gaps

- Orchestrator workers and non-planner levels get no images in v1 (`agents/Orchestrator.kt`).
- No image-reading tool; file paths in text are not auto-read.
- Image plus text clipboard pastes as text only.
- Animated GIF frame handling by providers is unverified.
- Deferred minors (from the image-attachments SDD ledger):
  - Media type comes from the extension, not content sniffing.
  - Photos downscaled above 1568 px are PNG and can exceed 5 MB, which is then rejected.
  - Decompression bombs are not guarded (OOM risk).
  - `ImageAttachment.toString` shows the array reference.
  - `fromImageNonBufferedImage` test may be flaky (async `getScaledInstance`); `encodePng` failure branch untested.
  - No end-to-end test of debug-log redaction in `chat()` for Claude; `ClaudeProvider.chat` stdin write is unexercised (CLI spawn not testable).
  - `renderStreamJson` is test-only.
  - Override matching is case-sensitive; bare `claude` hint matches non-vision `claude-2`; "gemma3n" needs an override.
  - Settings vision field layout needs a `runIde` look.
  - Stored media type is not validated on load; `VERSION` is still 1, so an older build would quarantine newer history.
  - SHA-256 is recomputed on every save.
  - Orphan sweep in `pruneExpired` is unlocked (narrow race with first save).
  - Compactor keeps images in the kept tail.
  - Thumbnail cache has no in-flight dedup and does not cache corrupt bytes.
  - Full-size image dialog decodes on the EDT.
  - Legacy `canImport(flavors)` rejects file lists.
  - Drop over read-only text areas is unconfirmed.
  - File chooser and click-to-open dialog are untested (modal).
  - Test titled "image only clipboard" is misnamed.
  - Debug-log test for Claude uses `logText()` directly, not `chat()`; `retentionDays` is not restored in one test teardown.

## Manual check (pending, `./gradlew runIde`)

- [ ] Paste a screenshot (Win+Shift+S / Flameshot) into the input; thumbnail appears; send; bubble shows it.
- [ ] Drop an image file on the input and on the chat area.
- [ ] Attach via 📎; attach via `/image <path>` (relative and absolute); reject a non-image and an oversize file.
- [ ] One model per provider (Ollama vision model, AIF vision model, Claude): confirm each describes the image.
- [ ] Non-vision model: send is blocked with the status message.
- [ ] Wayland clipboard: paste a screenshot and a copied file (`text/uri-list` drop).
- [ ] Restart the IDE: thumbnails reappear from `history/<projectHash>-images/`.
