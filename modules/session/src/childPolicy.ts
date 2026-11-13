import type { RoleDef } from "@stewart/config";
import { matchGlob } from "@stewart/roles-skills";
import { checkReadOnlyCommand, roleIsReadOnly } from "@stewart/tools";

/**
 * Deny reason for a call the role's profile does not allow, or null. Native-loop children are already limited by
 * their filtered tool registry; this applies the same profile to claude-code children, whose CLI keeps its own
 * tools: file edits need a write tool and a path inside `writePaths`, commands need `RunTerminal`
 * (read-only roles: read-only commands only).
 */
export function rolePolicyDeny(role: RoleDef, preview: { kind: string; path?: string; command?: string } | null): string | null {
  if (preview?.kind === "file") return fileDeny(role, preview.path);
  if (preview?.kind === "command") return commandDeny(role, preview.command);
  return null;
}

function fileDeny(role: RoleDef, path: string | undefined): string | null {
  if (roleIsReadOnly(role)) return `read-only role '${role.id}' cannot edit files`;
  if (role.writePaths.length && (!path || !role.writePaths.some((g) => matchGlob(g, path)))) {
    return `path '${path ?? ""}' is outside role '${role.id}' writePaths (${role.writePaths.join(", ")})`;
  }
  return null;
}

function commandDeny(role: RoleDef, command: string | undefined): string | null {
  if (role.tools.length && !role.tools.includes("RunTerminal")) return `role '${role.id}' has no RunTerminal tool`;
  if (!roleIsReadOnly(role) || typeof command !== "string") return null;
  try {
    checkReadOnlyCommand(command, role.id);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}
