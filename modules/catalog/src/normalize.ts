/** v1 ClaudeModels.normalize: "Claude Sonnet 4.5" → "sonnet"; other spaced names → kebab-case. */
export function normalizeModel(raw: string): string {
  const s = raw.trim();
  if (!/\s/.test(s)) return s;
  const m = /^(claude\s+)?(opus|sonnet|haiku)\b.*/i.exec(s);
  if (m) return m[2].toLowerCase();
  return s.toLowerCase().replace(/\s+/g, "-");
}
