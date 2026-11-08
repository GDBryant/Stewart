# Setup wizard

Settings → Run setup (opens automatically when no channels/agents exist). Steps: Welcome → Channels → Discover → Evaluator → Review → Done (`packages/webview/src/SetupWizard.tsx`).

- **Channels:** use existing channels or add a new one (presets: Ollama, OpenAI, OpenRouter, LM Studio, other OpenAI-compatible, Claude CLI). API keys go to the IDE secret store (`secret.set`); YAML holds only `secretRef`. Each channel is auto-tested; errors map to fixes. Once a channel tests ✓, tick which of its models go into the run (seeded from existing agents, or all models for a new channel); only ticked models flow to Discover/Evaluator/Review and `setup.recommend`.
- **Discover:** `channel.probe` per model (tools/vision/reasoning/imageGen/context).
- **Evaluator:** `rules` (default, no model call) or `ai` (chosen model refines).
- **Review:** editable role → `channel:model` table with reasons/warnings; unfillable roles are disabled. Apply writes `agents.yaml` + `roles.yaml`.

## Engine (`packages/core/src/assign.ts`, `recommend.ts`)
`scoreAssignments` filters on hard requirements (tools, vision, imageGen), ranks by soft weights (size parsed from name, reasoning, coder name, native tools, context, local/free), spreads near-equal load across models. AI picks failing hard requirements are dropped. Protocol: `setup.recommend {mode?, evaluator?, models?}` — `models` restricts candidates (and bench) to the ticked channel:model pairs.

## Not yet
Resume after IDE restart, YAML undo backup, Claude CLI auto-detect, quality-vs-free toggle.

## Cost flag
Agents carry optional `costs: boolean`. Default is derived: `priced`/`reported` billing, or a `claude-cli` channel. Settings shows a `$ costs` badge on the agent and on every role whose agent costs. The wizard sets `costs: true` on Claude CLI agents.
