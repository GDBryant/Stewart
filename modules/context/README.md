# @stewart/context

- Purpose: Prompt context: @mentions, image attachment limits, project context files
- Surface: `src/api.ts`
- Owns: `mentions.ts` (`expandMentions`), `images.ts` (`normalizeImages`, limits), `projectContext.ts` (`loadProjectContext`: bounded `AGENTS.md`/`MEMORY.md`)
- Depends on: `@stewart/kernel` (lower layers only; `scripts/layers.json`)
- Fake it: Pass `fakeHost()` with the files you want mentioned/loaded
