# @stewart/permissions

- Purpose: Approval categories, grants, tool previews, shell program splitter, approval gate
- Surface: `src/api.ts`
- Owns: `preview.ts` (`ToolPreview`, `ApprovalCategory`, `categoryOf`), `grants.ts` (`Grants` once/chat/always, audit), `shell.ts` (`splitShellPrograms`), `permissions.ts` (`Permissions` decide/ask/gate, session grants; `ApprovalDecision`/`ApprovalGate` types)
- Depends on: kernel, interaction (lower layers only; `scripts/layers.json`)
- Fake it: Stub `{ ask }` for `Permissions`; construct `Grants` directly
