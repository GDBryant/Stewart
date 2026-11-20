import type { Rule } from "../types.js";

const KEY = String.raw`(?:pass(?:word|wd|phrase)?|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret)`;
const ASSIGN = new RegExp(String.raw`(?<![A-Za-z0-9])${KEY}\w*["']?\s*([:=])\s*(["']?)([^\s"',;]{4,})`, "gi");
const AUTH = /\bAuthorization["']?\s*[:=]\s*["']?(?:Bearer|Basic|Token)\s+([A-Za-z0-9._~+/=-]{8,})/gi;
const URL_CRED = /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:([^\s@/]+)@/gi;
const PLACEHOLDER = /^(?:<.*>|\$\{.*\}|\$[A-Za-z_]+|\{\{.*\}\}|%.*%|\*+|x+|\.+|changeme|change_me|your[-_ ].*|example|password|passwd|secret|token|redacted|null|nil|undefined|none|true|false|string|number|boolean|any|unknown)$/i;
const CODE_REF = /\(|^(?:process\.env|os\.environ|os\.getenv|env\.|config\.|this\.|req\.|args\.)/i;

const SHAPES: Array<[string, RegExp]> = [
  ["private key block", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
  ["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{36,}\b/],
  ["API key (sk-)", /\bsk-[A-Za-z0-9_-]{20,}/],
  ["Slack token", /\bxox[baprs]-[A-Za-z0-9-]{10,}/],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["JWT", /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/],
  ["bearer token", /\bBearer\s+[A-Za-z0-9._~+/=-]{24,}/],
];

function isSecretValue(v: string): boolean {
  return !PLACEHOLDER.test(v) && !CODE_REF.test(v);
}

function assigned(text: string, re: RegExp, kind: string): string[] {
  for (const m of text.matchAll(re)) if (isSecretValue(m[1] ?? "")) return [kind];
  return [];
}

/** `key: word` with no quote and a plain-letter value reads as prose ("tokens: numbered lines"), not a credential. */
function assignment(text: string): string[] {
  for (const m of text.matchAll(ASSIGN)) {
    const [, sep, quote, value = ""] = m;
    const prose = sep === ":" && !quote && /^[A-Za-z]+$/.test(value);
    if (!prose && isSecretValue(value)) return ["secret assignment"];
  }
  return [];
}

function scan(text: string): string[] {
  const hits = [...assignment(text), ...assigned(text, AUTH, "authorization header"), ...assigned(text, URL_CRED, "credentials in URL")];
  for (const [kind, re] of SHAPES) if (re.test(text)) hits.push(kind);
  return [...new Set(hits)];
}

export const passwords: Rule = {
  id: "passwords",
  describe: "Passwords, API keys, tokens, private keys, credentials in URLs.",
  scan,
};
