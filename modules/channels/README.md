# @stewart/channels

- Purpose: Provider adapters plus the managed policy wrapper and registry
- Surface: `src/api.ts`
- Owns: `types.ts` (`ChannelAdapter`, `ChatRequest`/`ChatEvent`), `openai.ts`, `ollama.ts`, `claude/*`, `stream.ts`, `registry.ts` (`ChannelRegistry`, `ManagedChannel`: queue, `maxParallel`, breaker, stall, secrets)
- Depends on: `@stewart/catalog`, `@stewart/diagnostics`, `@stewart/kernel`, `@stewart/models` (lower layers only; `scripts/layers.json`)
- Fake it: Implement `ChannelAdapter` with an async-generator `chat` returning scripted `ChatEvent`s; wrap in `ManagedChannel` if policy matters
