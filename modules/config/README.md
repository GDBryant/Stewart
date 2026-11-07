# @stewart/config

- Purpose: YAML config files: schema, three-layer merge, store, SelfWriteGuard
- Surface: `src/api.ts`
- Owns: `schema.ts` (zod file schemas, `CONFIG_FILE_SCHEMAS`), `loader.ts` (shipped < user < project merge by id; no skill/role validation), `store.ts` (`ConfigStore`, `SelfWriteGuard`), `files.ts`, `userDir.ts` (`sharedUserConfigDir`, legacy migration)
- Depends on: `yaml`, `zod` (lower layers only; `scripts/layers.json`)
- Fake it: Pass an in-memory `ConfigStore` (`read()`/`write()` over a `Record<string,string>`) and YAML strings to `loadConfig`
