// Public surface of @stewart/config. Only this file is importable from outside.
export * from "./schema.js";
export { loadConfig, migrate } from "./loader.js";
export type { Config, ConfigLayer, RequiredRoleTools } from "./loader.js";
export { CONFIG_FILE_SCHEMAS, PROJECT_FILES, isProjectFile } from "./files.js";
export { SelfWriteGuard, hashContent } from "./store.js";
export type { ConfigStore } from "./store.js";
export { sharedUserConfigDir, ensureUserConfigDir } from "./userDir.js";
