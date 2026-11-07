# @stewart/toolcall-format

- Purpose: Shim tool-call text format: parser, prompt, live stream filter
- Surface: `src/api.ts`
- Owns: `shimParser.ts` (tag/JSON parsing, repair, aliases), `shimPrompt.ts`, `streamFilter.ts` (`ToolCallStreamFilter`)
- Depends on: `@stewart/kernel` (lower layers only; `scripts/layers.json`)
- Fake it: Pure; table tests with verbatim fixtures (see `test/`)
