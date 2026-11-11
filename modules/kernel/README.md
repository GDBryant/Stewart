# @stewart/kernel

- Purpose: Wire types, ports, EventBus and in-memory test fakes every other module builds on
- Surface: `src/api.ts`
- Owns: `wire.ts` (`Json`, `ToolCall`, `ChatMessage`, `ToolSpec`, `stripImages`), `ports.ts` (`HostPort` + narrow ports, `Clock`, `IdGen`, `Fetcher`, `systemClock`, `nodeFetch`), `events.ts` (`EventBus` delta coalescing), `faults.ts` (`FaultKind`), `mime.ts`, `testing.ts` (`fakeHost`, `fakeFetcher`, `collect`)
- Depends on: `@stewart/protocol` (lower layers only; `scripts/layers.json`)
- Fake it: Use `fakeHost()`/`fakeFetcher()` from this package; pass a hand-rolled `Clock` (`now`, `setTimeout`) for deterministic timers
