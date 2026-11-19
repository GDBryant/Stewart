export interface SlashParsed {
  name: string;
  args: string;
}

/** `/name args` when [input] starts with a single `/`; `//` escapes to plain text (see [slashPlainText]). */
export function parseSlash(input: string): SlashParsed | null {
  if (!input.startsWith("/") || input.startsWith("//")) return null;
  const body = input.slice(1);
  const ws = body.search(/\s/);
  const name = (ws < 0 ? body : body.slice(0, ws)).toLowerCase();
  if (!name) return null;
  return { name, args: ws < 0 ? "" : body.slice(ws).trim() };
}

/** Text to send for non-command input: a leading `//` sends a single `/`. */
export function slashPlainText(input: string): string {
  return input.startsWith("//") ? input.slice(1) : input;
}
