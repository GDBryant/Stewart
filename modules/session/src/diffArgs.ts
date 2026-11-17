const BASELINE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Project-relative path the diff viewer may open: no absolute paths, `..` segments, or `.git`. */
export function isDiffPath(path: string): boolean {
  if (!path || path.startsWith("/") || path.startsWith("\\") || /^[A-Za-z]:[\\/]/.test(path)) return false;
  const segs = path.split(/[\\/]+/);
  return segs[0] !== ".git" && !segs.includes("..");
}

/** Baseline ids become file/ref names: alphanumerics plus `.` `_` `-`, not leading with a dot. */
export function isBaselineId(id: string): boolean {
  return BASELINE_ID.test(id);
}
