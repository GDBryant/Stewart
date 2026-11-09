/** Streaming filter: hides shim tool-call blocks (`<tool_call>…</tool_call>` and variants) from live text deltas. */

import { callAttrTagEnd } from "./shimParser.js";

const ATTR_END_RE = /^<tool_call\s+name=(["'])[^"']+\1\s+arguments='[\s\S]*?'\s*>(?:\s*<\/tool_call>)?/;
const OPEN_RE = /<\|tool_call>|<tool_call>|<tool_call(?=\s)|<call>|<call(?=\s)|<function=[^>]*>|<\/tool_call>|<tool_call\|>|<\/call>|<\/function>/;
const LITERALS = ["<|tool_call>", "<tool_call>", "<tool_call", "<call>", "<function=", "</tool_call>", "<tool_call|>", "</call>", "</function>"];

type EndFn = (buf: string) => number;

const after = (closer: string): EndFn => (buf) => {
  const i = buf.indexOf(closer);
  return i === -1 ? -1 : i + closer.length;
};

function endFor(opener: string): EndFn | null {
  if (opener === "<|tool_call>") return after("<tool_call|>");
  if (opener === "<tool_call>") return after("</tool_call>");
  if (opener === "<call>") return after("</call>");
  if (opener === "<call") return (buf) => callAttrTagEnd(buf, 0);
  if (opener.startsWith("<function=")) return after("</function>");
  if (opener === "<tool_call") {
    const plain = after("</tool_call>");
    return (buf) => {
      const m = ATTR_END_RE.exec(buf);
      return m ? m[0].length : plain(buf);
    };
  }
  return null; // stray closer: dropped on its own
}

/** Longest suffix of `s` that could still grow into an opener. */
function heldSuffix(s: string): number {
  const fn = /<function=[^>]*$/.exec(s);
  if (fn) return s.length - fn.index;
  const ca = /<call(?=[\s/])[^>]*$/.exec(s);
  if (ca) return s.length - ca.index;
  for (let n = Math.min(s.length, 13); n > 0; n--) {
    const tail = s.slice(-n);
    if (LITERALS.some((l) => l.length > n && l.startsWith(tail))) return n;
  }
  return 0;
}

export class ToolCallStreamFilter {
  private buf = "";
  private end: EndFn | null = null;

  /** Feed a chunk; returns the text safe to show now. */
  push(chunk: string): string {
    this.buf += chunk;
    let out = "";
    for (;;) {
      if (this.end) {
        const e = this.end(this.buf);
        if (e === -1) return out;
        this.buf = this.buf.slice(e);
        this.end = null;
        continue;
      }
      const m = OPEN_RE.exec(this.buf);
      if (!m) {
        const keep = heldSuffix(this.buf);
        out += this.buf.slice(0, this.buf.length - keep);
        this.buf = keep ? this.buf.slice(-keep) : "";
        return out;
      }
      out += this.buf.slice(0, m.index);
      const fn = endFor(m[0]);
      if (fn) {
        this.buf = this.buf.slice(m.index);
        this.end = fn;
      } else {
        this.buf = this.buf.slice(m.index + m[0].length);
      }
    }
  }

  /** End of stream: the unfinished call block (or partial opener) that was held back. Show it only if no call parsed. */
  flush(): string {
    const held = this.buf;
    this.buf = "";
    this.end = null;
    return held;
  }
}
