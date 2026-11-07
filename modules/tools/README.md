# @stewart/tools

- Purpose: Tool registry, built-in tools by group, role guards, lease wrapper
- Surface: `src/api.ts`
- Owns: `types.ts` (`Tool`, `ToolRegistry`, outcomes), `toolBase.ts`, `fsRead.ts`/`fsWrite.ts`/`process.ts`/`media.ts`, `builtins.ts` (`projectTools`), `projectPaths.ts`, `roleRegistry.ts` (role filter + `writePaths`), `leaseGuard.ts` (`leasedTools`)
- Depends on: `@stewart/config`, `@stewart/context`, `@stewart/kernel`, `@stewart/permissions`, `@stewart/roles-skills`, `@stewart/run-state`, `@stewart/scheduling` (lower layers only; `scripts/layers.json`)
- Fake it: Register stub `Tool` objects in a `ToolRegistry`; run built-ins against `fakeHost()`
