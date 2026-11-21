/** Message text of a thrown value: `Error.message`, else `String(value)`. */
export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
