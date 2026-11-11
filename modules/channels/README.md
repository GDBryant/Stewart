# @stewart/channels

- Purpose: Provider adapters plus the managed policy wrapper and registry
- Surface: `src/api.ts`
- Owns: `types.ts` (`ChannelAdapter`, `ChatRequest`/`ChatEvent`), `openai.ts`, `ollama.ts`, `claude/*` (`parser.ts` + `parserBlocks.ts`), `stream.ts`, `registry.ts` (`ChannelRegistry`, `ManagedChannel`: queue, `maxParallel`, breaker, stall, secrets), `service.ts` (`ChannelService`: rebuild/get/require/health/probe/setSecret)
- Depends on: `@stewart/catalog`, `@stewart/diagnostics`, `@stewart/kernel`, `@stewart/models` (lower layers only; `scripts/layers.json`)
- Fake it: Implement `ChannelAdapter` with an async-generator `chat` returning scripted `ChatEvent`s; register it in a `ChannelRegistry` for `ChannelService`, or wrap in `ManagedChannel` if policy matters
