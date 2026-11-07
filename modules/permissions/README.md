# @stewart/permissions

- Purpose: Approval categories, grants, tool previews, shell program splitter
- Surface: `src/api.ts`
- Owns: `preview.ts` (`ToolPreview`, `ApprovalCategory`, `categoryOf`), `grants.ts` (`Grants` once/chat/always, audit), `shell.ts` (`splitShellPrograms`)
- Depends on: — (leaf) (lower layers only; `scripts/layers.json`)
- Fake it: Pure; construct `Grants` directly
