# Setup Wizard Rewrite

## Problem
Current `SetupWizard` (`packages/webview/src/SettingsView.tsx:287`) is one form: one channel, one agent, no API key field (openai-compatible is unusable on first run), no guidance, and role assignment is an LLM-only side button (`recommendAssignments`, `packages/core/src/recommend.ts`) that depends on a model already working and has no deterministic fallback. Failure mode seen in logs: a weak model (gemma4:e4b) was left as orchestrator because nothing checked fitness.

## Goals
1. Walk a new user through setup with plain-language steps and no prior knowledge.
2. Add **multiple channels** (Ollama, openai-compatible with URL + API key, Claude CLI), each tested.
3. Pick **channel + model ("evaluator agent")** to run the assignment.
4. Assign agents to roles by best-matched abilities among what is actually available; show the reasoning; let the user edit before applying.
5. Re-runnable from Settings at any time (not first-run only), never destructive without a diff preview.

## Wizard flow (5 steps, linear, Back/Next, progress bar, resumable)
| # | Step | Content |
|---|------|---------|
| 0 | Welcome | What Stewart does; what a channel / agent / role is (3 one-liners); "you need at least one model source". Skip → manual settings. |
| 1 | Channels | Cards per type with *when to use* text. Fields: id, type, baseUrl, **API key** (secret → IDE secret store, never plain YAML), extraModels. Presets: Ollama `http://localhost:11434`, OpenAI, OpenRouter, LM Studio, Claude CLI path. "Test connection" per channel shows ✓/✗ with the actionable error (not running, 401 bad key, no models). "Add another channel". Next enabled when ≥1 channel passes. |
| 2 | Discover | Auto list models + probe caps (`channel.probe`: tools/vision/reasoning/imageGen/context) for all passing channels, progress per model; unreachable ones flagged, not fatal. Show a capability table. |
| 3 | Choose evaluator | Select channel + model that runs the assignment (default: strongest tool-capable reasoning model; shown with why). Options: **"Auto (rules only, no AI)"** / "Ask this model to refine". |
| 4 | Review & apply | Table role → agent (channel:model), score, reason, cost/billing badge, editable dropdowns, warnings (e.g. "orchestrator on a <8B model", "no vision model: image-reader disabled"). Diff of `agents.yaml`/`roles.yaml`. Apply / Back. |
| 5 | Done | Summary, "Try it" sample prompt, link to re-run. |

## Assignment engine (core, `packages/core/src/recommend.ts`)
Two layers; layer 1 always runs, layer 2 is optional.
1. **Deterministic scorer** (new `scoreAssignments(config, channelInfos)`): per-role requirement profile (data, in `defaults/roles.ts` or `roleProfiles.ts`):
   - orchestrator/planner/plan-validator: needs `tools≠none`, prefers `reasoning`, min context 16k, min size heuristic (parse `NNb` from name; penalise <8B), weight on instruction-following.
   - code-writer/general-worker/tester: native tools, large context, coding-named models bonus.
   - image-reader: `vision` required; image-writer: `imageGen` required; document-writer: cheap/fast preferred.
   - Hard requirements filter; soft weights rank. Billing tie-break: free/local > reported > priced, unless user marks "prefer quality".
   - Spread rule: avoid one model for every role when alternatives are ≥90% as good (parallelism); allow single-model mode when only one exists.
   - Unfillable role → `enabled: false` with reason, never a silently bad pick.
2. **LLM refinement** (existing prompt): given the scorer's proposal + capability table, evaluator may adjust; result is validated against discovered models (existing validation) and **only accepted if every hard requirement still holds**. On failure/parse error → fall back to layer 1 and say so.
Output type extended: `score`, `reason`, `warnings[]`, `source: "rules" | "ai"` per assignment.

## Protocol / state
- New messages: `setup.discover` (list+probe all channels, streamed progress), `setup.recommend {evaluator?: {channel,model}, mode: "rules"|"ai"}` (extends existing). Existing `setup.recommend.result` gains the new fields.
- `setup.apply {assignments, channels, agents}` atomic write of channels/agents/roles with secrets via secret store; backup of prior YAML for undo.
- Wizard state in `state.ts`: `wizard: {step, channels[], discovery, evaluator, proposal}`; persisted so a closed IDE resumes.
- Both hosts (JetBrains `WebviewRouter.kt`, VS Code `extension.ts`) only pass messages through; add routes + tests.

## UX copy (first-run instructions)
Each step has a short "What to do" box and a "Why" tooltip. Examples: Ollama – "Install from ollama.com, run `ollama pull qwen3`, then Test"; API key – "Stored in your IDE's secret storage, not in files"; Evaluator – "This model reads the list of what you have and decides who does what. A bigger model gives better choices; Auto needs no model". Errors are mapped to fixes (connection refused → "Is Ollama running?"; 401 → "Check the key").

## Milestones
1. **Engine**: role profiles + `scoreAssignments` + tests (each role's hard requirement positive/negative, no-vision, single-model, tie-break, free vs paid). Fold LLM refinement behind validation. 
2. **Protocol + core**: `setup.discover`, extended `setup.recommend`, `setup.apply` (+ undo), secret handling; host routing + Kotlin/VS Code tests.
3. **Webview**: stepper component, channel step with API key + presets, discovery table, evaluator picker, review/edit table with diff; resume state; replace `SetupWizard`; keep Settings re-run entry.
4. **Copy + docs**: instructions text, `docs/SETUP.md`, update AGENTS.md references, PROGRESS.md.
5. **E2E**: webview tests for the full flow (fake bridge), JCEF e2e smoke, manual check with Ollama-only, openai-compatible-only, and mixed setups.

## Acceptance
- A new user with only an OpenAI-compatible URL + key completes setup without touching YAML.
- With no working LLM, "Auto" still produces a valid, explained assignment.
- Orchestrator is never assigned a model failing its hard requirements without a visible warning.
- No API key appears in YAML, logs, or debug files.
- Coverage ≥90% line / ≥80% branch on new code; positive and negative tests for each piece.

## Open questions
1. Keep the old `setup.recommend` button inside Settings, or fold it into the re-run wizard only?
2. Size heuristic from model names is fuzzy; acceptable, or add a small curated model-knowledge table (updatable)?
3. Should "prefer quality vs prefer free/local" be a wizard toggle?
4. Include the Claude CLI channel auto-detection (find `claude` on PATH) in step 1?
