import { firstJsonValueEnd, skipWhitespace } from "./jsonRepair.js";

const CHANNEL_MARKER_RE = /<\|?channel\|?>(?:thought\n?)?/g;
const ATTR_CALL_RE = /<tool_call\s+name=(["'])([^"']+)\1\s+arguments='([\s\S]*?)'\s*>(?:\s*<\/tool_call>)?/g;

const CALL_ATTR_OPEN_RE = /<call(?=[\s/])/g;

export interface CallAttrScan {
  name?: string;
  args?: string;
  end: number;
  complete: boolean;
}

/** One attribute read from a call tag: its key, raw value and quoting kind. */
interface CallAttr {
  key: string;
  raw: string;
  kind: "sq" | "dq" | "raw";
}

function applyCallAttr(cur: { name?: string; args?: string }, attr: CallAttr): { name?: string; args?: string } {
  const { name, args } = cur;
  const { key, raw, kind } = attr;
  if (key === "name" && kind !== "raw") return { name: decodeAttrValue(raw, kind), args };
  if (key === "arguments" || key === "args" || key === "parameters") return { name, args: decodeAttrValue(raw, kind) };
  return { name, args };
}

function tagDelimiter(text: string, i: number, scan: CallAttrScan): CallAttrScan | null | "attr" {
  const c = text[i];
  if (c === ">") return finishCallAttrTag(text, { ...scan, end: i + 1, complete: true });
  if (c !== "/") return "attr";
  if (i + 1 >= text.length) return { ...scan, end: i, complete: false };
  if (text[i + 1] === ">") return finishCallAttrTag(text, { ...scan, end: i + 2, complete: true });
  return null;
}

/** Scan a `<call name="X" arguments={...}>` attribute tag starting at `start` (which points at `<call`). */
export function scanCallAttrTag(text: string, start: number): CallAttrScan | null {
  let i = start + "<call".length;
  let name: string | undefined;
  let args: string | undefined;
  for (;;) {
    i = skipWhitespace(text, i);
    if (i >= text.length) return { name, args, end: i, complete: false };
    const d = tagDelimiter(text, i, { name, args, end: i, complete: false });
    if (d === null) return null;
    if (d !== "attr") return d;
    const km = /^[A-Za-z_][\w-]*/.exec(text.slice(i));
    if (!km) return null;
    const key = km[0];
    i = skipWhitespace(text, i + km[0].length);
    if (text[i] !== "=") continue;
    const v = readAttrValue(text, skipWhitespace(text, i + 1));
    if (v === null) return { name, args, end: i, complete: false };
    const [raw, vend, kind] = v;
    i = vend;
    ({ name, args } = applyCallAttr({ name, args }, { key, raw, kind }));
  }
}

/** End index (exclusive) of a `<call ...>` attribute tag at `start`, or -1 when incomplete or malformed. */
export function callAttrTagEnd(text: string, start: number): number {
  const scan = scanCallAttrTag(text, start);
  if (scan !== null) {
    if (!scan.complete) return -1;
    return scan.end;
  }
  const gt = text.indexOf(">", start + "<call".length);
  return gt === -1 ? -1 : gt + 1;
}

function quotedAttrValue(text: string, i: number, q: string): [string, number, "sq" | "dq"] | null {
  let j = i + 1;
  while (j < text.length) {
    if (text[j] === "\\") {
      j += 2;
      continue;
    }
    if (text[j] === q) return [text.slice(i + 1, j), j + 1, q === '"' ? "dq" : "sq"];
    j++;
  }
  return null;
}

function readAttrValue(text: string, i: number): [string, number, "sq" | "dq" | "raw"] | null {
  if (i >= text.length) return null;
  const c = text[i];
  if (c === '"' || c === "'") {
    return quotedAttrValue(text, i, c);
  }
  if (c === "{" || c === "[") {
    const endRel = firstJsonValueEnd(text.slice(i));
    if (endRel === -1) return null;
    return [text.slice(i, i + endRel), i + endRel, "raw"];
  }
  return null;
}

function decodeAttrValue(raw: string, kind: "sq" | "dq" | "raw"): string {
  if (kind === "dq") {
    try {
      const v = JSON.parse(`"${raw}"`);
      if (typeof v === "string") return v;
    } catch {
    }
  }
  return raw;
}

function finishCallAttrTag(text: string, scan: CallAttrScan): CallAttrScan {
  let e = scan.end;
  while (e < text.length && " \t\r\n".includes(text[e])) e++;
  if (text.startsWith("</call>", e)) scan.end = e + "</call>".length;
  return scan;
}

/** Rewrite `<call name="X" arguments={...}/>` attribute tags to the canonical <tool_call> JSON form. */
function rewriteCallAttrs(text: string): string {
  CALL_ATTR_OPEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  let out = "";
  let p = 0;
  while ((m = CALL_ATTR_OPEN_RE.exec(text))) {
    const scan = scanCallAttrTag(text, m.index);
    if (scan === null || !scan.complete || scan.name === undefined) continue;
    out += text.slice(p, m.index);
    out += `<tool_call>{"name":${JSON.stringify(scan.name)},"arguments":${scan.args ?? "{}"}}</tool_call>`;
    p = scan.end;
    CALL_ATTR_OPEN_RE.lastIndex = scan.end;
  }
  return p === 0 ? text : out + text.slice(p);
}

/** Drop Gemma channel markers and rewrite `<tool_call name="X" arguments='{..}'>` to the JSON body form. */
export function normalizeShapes(text: string): string {
  return rewriteCallAttrs(
    text
      .replace(CHANNEL_MARKER_RE, "")
      .replace(ATTR_CALL_RE, (_m, _q, name: string, args: string) => `<tool_call>{"name":${JSON.stringify(name)},"arguments":${args}}</tool_call>`),
  );
}
