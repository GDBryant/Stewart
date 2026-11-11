// Public surface of @stewart/permissions. Only this file is importable from outside.
export { categoryOf } from "./preview.js";
export type { ToolPreview, ApprovalCategory } from "./preview.js";
export { Grants, isScratchPath } from "./grants.js";
export type { GrantScope, GrantDecision, AuditEntry } from "./grants.js";
export { splitShellPrograms } from "./shell.js";
export { Permissions } from "./permissions.js";
export type { ApprovalDecision, ApprovalGate, PermissionDecision, PermissionRequest, ApproveFn } from "./permissions.js";
