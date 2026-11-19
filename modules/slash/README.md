# @stewart/slash

- Purpose: slash command parser, registry and the built-in local commands (`/help`, `/init`, `/clear`).
- Surface: `src/api.ts` — `parseSlash`, `slashPlainText`, `runSlash(registry, deps, input, sessionId?)`, `createRegistry`, `builtinCommands`, `ensureInitFiles`, `INIT_*` constants, types `SlashCommand`/`SlashContext`/`SlashSessionPort`/`SlashRegistry`/`SlashCommandInfo`.
- Owns: `//` escape, unknown-command hint, `chat.local` output (`say`), command lookup; session capabilities arrive only through `SlashSessionPort` (wired in core — never `@stewart/session`).
- Depends on: `@stewart/kernel`, `@stewart/interaction`, `@stewart/protocol`.
- Fake it: `fakeHost` + `Interaction` + a stub `SlashSessionPort`; collect bus events until the expected `chat.local`/`ask_user`.
