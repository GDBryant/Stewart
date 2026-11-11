import { SETUP_FILES, type SetupSessionDeps } from "./sessionTypes.js";

export async function backupSetupFiles(deps: SetupSessionDeps, base: Record<string, string | undefined>, backupDir: string): Promise<void> {
  for (const f of SETUP_FILES) {
    const cur = base[f];
    if (cur !== undefined) await deps.files.writeAtomic(`${backupDir}/${f}`, cur);
  }
}

export async function writeSetupFiles(deps: SetupSessionDeps, files: Record<string, string>): Promise<void> {
  for (const f of SETUP_FILES) {
    if (files[f] !== undefined) await deps.writeUserFile(f, files[f]);
  }
}

export async function restoreSetupFiles(deps: SetupSessionDeps, base: Record<string, string | undefined>): Promise<void> {
  for (const f of SETUP_FILES) {
    const cur = base[f];
    if (cur !== undefined) await deps.writeUserFile(f, cur).catch(() => {});
  }
}
