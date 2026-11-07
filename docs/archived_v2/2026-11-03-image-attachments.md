# Image Attachments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user attach screenshots to a chat message by file path/picker/drag-drop or by pasting from the clipboard, and send them to vision-capable models on all three providers.

**Architecture:** Add `images: List<ImageAttachment>` to `ChatMessage` (default empty, so existing call sites compile). Each provider serialises images in its own wire format. The UI keeps a pending-attachments strip above the input; images are held in memory, persisted to disk beside chat history (not inline in the JSON), and shown as thumbnails in the user bubble.

**Tech Stack:** Kotlin, Swing/IntelliJ UI (`JBTextArea`, `TransferHandler`, `ImageIO`), kotlinx.serialization.

**Spec:** this document (no separate spec). Findings below.

## Global Constraints

- Brief docs; every change ships positive and negative tests; `./gradlew koverVerify` (≥90% line, ≥80% branch) must pass (AGENTS.md).
- Add this plan and a `docs/IMAGES.md` reference to AGENTS.md when done; update `docs/PROGRESS.md`.
- No provider may receive images silently dropped: if the selected model is not vision-capable, block the send with a visible message.

## Investigation findings

| Area | Today | Needed |
|---|---|---|
| `ChatMessage` (`provider/ModelProvider.kt`) | `content: String` only | `images` field |
| Ollama (`OllamaProvider.kt:134-139`) | `put("content", …)` | add `"images": [base64,…]` (raw base64, no data-URL prefix). Vision support visible via `/api/show` `capabilities` contains `"vision"` (same call already used for `"tools"`, ~line 121) |
| AIF (`AifProvider.kt` `messageJson` ~286, `AifHistory.sanitize`) | `put("content", string)` | OpenAI-style content array: `[{type:text,text},{type:image_url,image_url:{url:"data:image/png;base64,…"}}]`; `sanitize` copies messages so images must survive its `copy`/`asText` paths. Vision support unknown per model → user-overridable allowlist |
| Claude CLI (`ClaudeProvider.kt:78-84`, `ClaudeTranscript.render`) | `-p` with plain-text stdin, transcript flattened to text | Plain text cannot carry images. Switch to `--input-format stream-json` (CLI supports it with `--print`) and write one `{"type":"user","message":{"role":"user","content":[text,image blocks…]}}` line to stdin. **Must be proven by a live spike (Task 1) before building on it.** Fallback: write image to temp file and reference by path (CLI `--tools ""` blocks Read, so fallback needs tool enabling — avoid) |
| Shim (`shim/RequestTranslator.kt`) | merges `content` strings | pass images through untouched on the last user message; shim is text-tool fallback only |
| History (`ChatHistoryStore.kt`) | `StoredMessage(content,…)`, version field | add `images: List<StoredImage>` as file refs; bump version handling; retention prune must delete image files too |
| Compaction / tokens (`ContextCompactor`, `TokenEstimate.kt`) | chars/4 | count image as fixed ~1,500 tokens; compactor drops images from summarised messages |
| UI (`ChatPanel.kt`: `inputArea` L97, `onSubmit` L1016, `addMessage` L773, `BubbleArea`) | text only, no paste/drop handling | paste handler, drop handler, attach button, preview strip, thumbnail in bubble |
| Debug log (`DebugLogSink`) | logs text | log `[image png 123KB]` placeholders, never base64 |
| Agents (`Orchestrator`, `WorkerBriefing`) | text briefs | images stay on the user message sent to the router/planner only; workers get none (v1) |
| Tools | no image-reading tool | out of scope (v1): `@file` path reference in text is *not* auto-read; the attach button/path flow is the file route |

**Input routes (all produce an `ImageAttachment`):**
1. Clipboard paste (Ctrl/Cmd+V in input) — `DataFlavor.imageFlavor` → `BufferedImage` → PNG bytes.
2. Drag-and-drop file(s) — `DataFlavor.javaFileListFlavor`, filter by extension.
3. Attach button (📎) — `FileChooser` with image filter.
4. Slash command `/image <path>` — handles "reference as file" from keyboard; path resolved relative to project, must be within project or an absolute file the user typed (explicit user action, so no permission prompt).

**Limits:** png/jpg/jpeg/gif/webp; max 5 MB per image (downscale longest edge to 1568 px, re-encode PNG/JPEG); max 5 images per message. Constants in one place (`ImageLimits`).

---

### Task 1: Claude CLI stream-json image spike (gate)

**Files:**
- Create: `docs/IMAGES.md` (spike result section)
- Test: `src/test/kotlin/com/adb/stewart/ClaudeImageLiveTest.kt` (skipped unless `CLAUDE_LIVE=1`)

**Interfaces:** Produces: confirmed stdin JSON shape for image input.

- [ ] **Step 1:** Run by hand with `docs/Future/Screenshot from 2026-11-03 15-45-29.png` base64'd:
  ```bash
  B64=$(base64 -w0 "docs/Future/Screenshot from 2026-11-03 15-45-29.png")
  printf '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Describe this image"},{"type":"image","source":{"type":"base64","media_type":"image/png","data":"%s"}}]}}\n' "$B64" \
    | claude -p --input-format stream-json --output-format stream-json --verbose --tools "" --safe-mode --no-session-persistence
  ```
  Expected: assistant text describing the image. If not, record the error in `docs/IMAGES.md` and pick fallback with the user before continuing.
- [ ] **Step 2:** Check the stream-json **output** parser (`ClaudeStreamParser`) is unaffected by `--input-format stream-json` (init/system events may differ); record differences.
- [ ] **Step 3:** Write the live test asserting a non-empty reply to a tiny generated PNG (a solid red 8×8 image, "what colour?" → contains "red", case-insensitive).
- [ ] **Step 4:** Commit `docs: image spike for Claude CLI`.

### Task 2: Model — `ImageAttachment` + `ChatMessage.images`

**Files:**
- Create: `src/main/kotlin/com/adb/stewart/chat/ImageAttachment.kt`, `ImageLimits.kt`, `ImageLoader.kt`
- Modify: `provider/ModelProvider.kt` (`ChatMessage`)
- Test: `src/test/kotlin/com/adb/stewart/ImageLoaderTest.kt`

**Interfaces:**
- Produces:
  ```kotlin
  data class ImageAttachment(val mediaType: String, val bytes: ByteArray, val name: String) {
      fun base64(): String
      fun dataUrl(): String          // "data:image/png;base64,…"
      // equals/hashCode on contentEquals
  }
  object ImageLoader {
      fun fromFile(path: Path): Result<ImageAttachment>      // ext + size + decodable check
      fun fromImage(img: java.awt.Image, name: String = "pasted.png"): ImageAttachment // PNG
      fun normalize(a: ImageAttachment): ImageAttachment      // downscale to ImageLimits.MAX_EDGE, enforce MAX_BYTES
  }
  object ImageLimits { const val MAX_BYTES = 5_000_000; const val MAX_EDGE = 1568; const val MAX_PER_MESSAGE = 5; val EXTENSIONS = setOf("png","jpg","jpeg","gif","webp") }
  ```
- `ChatMessage` gains `val images: List<ImageAttachment> = emptyList()` as the **last** parameter.

- [ ] **Step 1:** Write failing tests: valid PNG loads; `.txt` rejected; non-image bytes with `.png` extension rejected; >5 MB rejected after normalise; 4000×3000 image downscaled to ≤1568 edge; `fromImage` yields decodable PNG; missing file → failure.
- [ ] **Step 2:** `./gradlew test --tests '*ImageLoaderTest*'` → FAIL.
- [ ] **Step 3:** Implement with `ImageIO`/`Files`. Negative paths return `Result.failure` with a user-readable message.
- [ ] **Step 4:** Tests PASS; full `./gradlew test` still green (default param keeps old call sites).
- [ ] **Step 5:** Commit `feat: image attachment model and loader`.

### Task 3: Providers serialise images

**Files:**
- Modify: `provider/ollama/OllamaProvider.kt` (~134), `provider/aif/AifProvider.kt` (`messageJson`, `AifHistory.sanitize` ~344-380), `provider/claude/ClaudeProvider.kt` + `ClaudeTranscript.kt`, `shim/RequestTranslator.kt`
- Test: `OllamaProviderTest.kt`, `AifProviderTest.kt`, `ClaudeTest.kt`, shim tests

**Interfaces:**
- Consumes: `ChatMessage.images`, `ImageAttachment.base64()/dataUrl()`.
- Produces: `ClaudeTranscript.renderStreamJson(messages): Pair<String /*system*/, String /*stdin NDJSON*/>` (text-only conversations keep the old plain path so existing behaviour/tests are unchanged; stream-json only when any message has images).

- [ ] **Step 1: Failing tests**
  - Ollama: message with 1 image → JSON has `images:["<b64>"]`; without → no `images` key.
  - AIF: with images → `content` is array of text + `image_url` data URL parts; without → `content` still a string (regression); `sanitize` preserves images on user messages.
  - Claude: with images → argv contains `--input-format stream-json`; stdin is one JSON line with `type:"user"` and `image` block; prior turns are folded into the text block using the existing transcript text; without images → argv unchanged.
  - Shim: merging/`copy` keeps `images`.
- [ ] **Step 2:** Run, confirm FAIL.
- [ ] **Step 3:** Implement per table above. Claude: only the last user message's images are sent as blocks; images in earlier turns become `[image: name]` text (keeps stdin a single message).
- [ ] **Step 4:** Run provider tests → PASS.
- [ ] **Step 5:** Commit `feat: send images to Ollama, AIF and Claude providers`.

### Task 4: Vision capability gate

**Files:**
- Modify: `provider/ModelProvider.kt` (add `fun supportsImages(model: String): Boolean = false`), each provider; `settings/StewartSettings.kt` (+ `visionModelOverrides: MutableSet<String>`), `StewartConfigurable.kt`
- Test: provider tests + `StewartSettings` test

**Interfaces:** Produces `ModelProvider.supportsImages(model)`; Ollama = `capabilities` contains `"vision"` (cached like tools check); Claude = true for all current models (`ClaudeModels`); AIF = name heuristic (`vl`, `vision`, `gpt-4o`, `gemma3`, `llava`, `qwen2.5-vl`, …) **or** user override list.

- [ ] **Step 1:** Tests: Ollama show with/without `vision`; AIF heuristic hits/misses + override; Claude true; unknown error → false.
- [ ] **Step 2–4:** Fail → implement → pass.
- [ ] **Step 5:** Commit `feat: per-model vision capability`.

### Task 5: Persistence, tokens, compaction, debug log

**Files:**
- Modify: `chat/ChatHistoryStore.kt`, `chat/TokenEstimate.kt`, `chat/ContextCompactor.kt`, `debug/DebugLogSink.kt` callers
- Test: `HistoryAndFormatTest.kt`, `ContextCompactorTest.kt`, `DebugLogSinkTest.kt`

**Interfaces:** `StoredMessage` gains `images: List<StoredImage> = emptyList()` (`StoredImage(file: String, mediaType: String, name: String)`); image bytes written to `history/<projectHash>-images/<sha256>.<ext>`; `load` reads them back (missing file → drop that image, keep message). `pruneExpired` and `delete()` remove the images dir. `TokenEstimate.of` adds `IMAGE_TOKENS = 1500` per image.

- [ ] **Step 1: Failing tests:** save/load round-trip preserves image bytes; old JSON without `images` still loads; missing image file doesn't quarantine chat; delete/prune remove image files; token estimate increases by 1500 per image; compactor summary input excludes image bytes (placeholder text); debug log line contains `[image` and no base64 (assert no 100+ char base64 run).
- [ ] **Step 2–4:** Fail → implement → pass.
- [ ] **Step 5:** Commit `feat: persist and account for image attachments`.

### Task 6: UI — paste, drop, attach, preview, thumbnail

**Files:**
- Create: `ui/AttachmentStrip.kt` (preview row with thumbnail + name + ✕), `ui/ImageTransferHandler.kt`
- Modify: `ui/ChatPanel.kt` (`inputArea` L97, input panel ~L238, `onSubmit` L1016, `startSend` L1031, `addMessage` L773, `onClear`), `chat/ChatSession.kt` (`send(text, ref, listener, images = emptyList())` L214; transcript add `ChatMessage(Role.USER, text, images = images)`), `chat/SlashCommands.kt` (`/image <path>`)
- Test: `ChatPanelTest.kt`, `ImageTransferHandlerTest.kt`, `ChatSessionTest.kt`, `SlashCommandsTest`

**Interfaces:**
- Consumes: `ImageLoader`, `ModelProvider.supportsImages`.
- Produces: `ChatPanel.pendingImages: List<ImageAttachment>`, `ChatPanel.attach(a: ImageAttachment): Boolean`, `ChatPanel.clearAttachments()`; `ImageTransferHandler(onImage: (ImageAttachment)->Unit, onError: (String)->Unit, fallback: TransferHandler)` — `canImport` true for `imageFlavor` or file list with image extension; non-image text paste delegates to `fallback` (must not break normal paste).

- [ ] **Step 1: Failing tests**
  - Paste image transferable → `pendingImages` size 1, strip visible. Paste plain text → text inserted, no image (negative).
  - Drop file list with `a.png` + `b.txt` → only png attached, error shown for txt.
  - 6th image rejected with message; oversized rejected.
  - Submit with an image and empty text is allowed (image-only message, empty `content`; `onSubmit`'s blank-text check must consider attachments). Submit with non-vision model → blocked, error in status label, attachments retained, nothing sent.
  - After send: strip cleared, user bubble shows thumbnail(s); `session.transcript.last().images` set.
  - `/image path/to/x.png` attaches; `/image missing.png` reports error; `/image` with no arg shows usage.
  - `Clear` removes attachments.
- [ ] **Step 2:** FAIL.
- [ ] **Step 3:** Implement. Thumbnail: scale to max 160 px, in a `JLabel` inside `MessageRow`; click opens full-size in a `DialogWrapper`. Install handler on `inputArea` plus the whole panel (drop anywhere). Attach button uses `FileChooserDescriptorFactory.createSingleFileDescriptor()` filtered by `ImageLimits.EXTENSIONS`.
- [ ] **Step 4:** Tests PASS.
- [ ] **Step 5:** Commit `feat: attach images by paste, drop, picker and /image`.

### Task 7: Docs, coverage, manual check

**Files:** Modify `AGENTS.md` (reference list), `docs/PROGRESS.md`; finalize `docs/IMAGES.md`.

- [ ] **Step 1:** `docs/IMAGES.md`: routes, limits, per-provider wire format, vision gate, persistence layout, known gaps (workers get no images; no image-reading tool; GIF first frame only on Ollama).
- [ ] **Step 2:** `./gradlew test koverVerify` → PASS (fix coverage gaps with negative tests, not exclusions).
- [ ] **Step 3:** `./gradlew runIde`: paste a screenshot (Win+Shift+S / Flameshot), drop a file, attach via 📎 against one model per provider; confirm each describes the image.
- [ ] **Step 4:** Commit `docs: image attachments`.

## Risks / open questions

1. **Claude CLI image input** is the main unknown — gated by Task 1. If `stream-json` stdin with `--safe-mode`/`--no-session-persistence` rejects images, options are the temp-file + Read tool route (weakens current `--tools ""` lockdown) or restricting Claude to text.
2. **AIF vision support** is model-dependent and not discoverable via the models list → heuristic + user override list.
3. **Wayland clipboard** (Linux dev box): AWT image flavor under XWayland can return null for some apps; add file-URI fallback (`text/uri-list`) in the handler and test manually.
4. **History size**: images on disk follow the existing retention setting; confirm acceptable disk use with the user.
5. **Orchestrator levels**: v1 forwards images only to the first-level (router/planner) message; decide whether workers should receive them (needs `WorkerBriefing` change).
