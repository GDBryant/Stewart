# @stewart/engines

- Purpose: how an agent runs. `native-loop` = Stewart's loop over a channel's native tool calling; `claude-code` (step 2, not built) will supervise the Claude CLI.
- Surface: `src/api.ts` — `Engine`, `EngineTurn`, `EngineEvent`, `WriteRecord`, `nativeLoop`, `engineFor(channelType)`.
- Owns: the model↔tool turn loop: stream text/reasoning/usage, validate + gate + execute tool calls, append assistant/tool messages to the transcript, emit `write` records for WriteFile/EditFile/ApplyPatch.
- Depends on: `@stewart/kernel`, `@stewart/config`, `@stewart/channels`, `@stewart/permissions`, `@stewart/tools`.
- Fake it: `ManagedChannel` over a scripted `ChannelAdapter` (see test) + stub `Tool`s in a `ToolRegistry`.
