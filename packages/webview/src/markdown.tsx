import type { ComponentChildren, VNode } from "preact";

/** Link URLs that would execute script or embed data are dropped (href omitted). */
function safeUrl(u: string): string | undefined {
  return /^\s*(javascript|data|vbscript):/i.test(u) ? undefined : u;
}

/** Split a `|` row into trimmed cells. */
function cells(line: string): string[] {
  const t = line.trim();
  const s = t.startsWith("|") ? t.slice(1) : t;
  const e = s.endsWith("|") ? s.slice(0, -1) : s;
  return e.split("|").map((c) => c.trim());
}

/** A GFM separator row: every cell is dashes with optional alignment colons. */
function isSepRow(line: string): boolean {
  const cs = cells(line);
  return cs.length >= 2 && cs.every((c) => /^:?-+:?$/.test(c));
}

/** Index of the first single `*` (not part of a `**` pair); -1 when there is none. */
function singleStar(s: string): number {
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "*" && s[i - 1] !== "*" && s[i + 1] !== "*") return i;
  }
  return -1;
}

interface Span {
  pos: number;
  next: number;
  render: (keyBase: string, k: number) => ComponentChildren;
}

function codeSpan(s: string): Span | null {
  const cb = s.indexOf("`");
  if (cb < 0) return null;
  const ce = s.indexOf("`", cb + 1);
  if (!(ce > cb)) return null;
  return { pos: cb, next: ce + 1, render: (kb, k) => <code key={`${kb}c${k}`}>{s.slice(cb + 1, ce)}</code> };
}

function boldSpan(s: string): Span | null {
  const bb = s.indexOf("**");
  if (bb < 0) return null;
  const be = s.indexOf("**", bb + 2);
  if (!(be > bb)) return null;
  return { pos: bb, next: be + 2, render: (kb, k) => <strong key={`${kb}s${k}`}>{inline(s.slice(bb + 2, be), `${kb}st${k + 1}`)}</strong> };
}

function italicSpan(s: string): Span | null {
  const ib = singleStar(s);
  if (ib < 0) return null;
  const ie = s.indexOf("*", ib + 1);
  if (!(ie > ib)) return null;
  return { pos: ib, next: ie + 1, render: (kb, k) => <em key={`${kb}e${k}`}>{inline(s.slice(ib + 1, ie), `${kb}em${k + 1}`)}</em> };
}

function linkSpan(s: string): Span | null {
  const lb = s.indexOf("[");
  const lt = lb >= 0 ? s.indexOf("](", lb) : -1;
  const le = lt >= 0 ? s.indexOf(")", lt) : -1;
  if (!(le > lt)) return null;
  return {
    pos: lb,
    next: le + 1,
    render: (kb, k) => (
      <a key={`${kb}a${k}`} href={safeUrl(s.slice(lt + 2, le))} target="_blank" rel="noreferrer noopener">
        {s.slice(lb + 1, lt)}
      </a>
    ),
  };
}

const SPAN_FINDERS = [codeSpan, boldSpan, italicSpan, linkSpan];

function firstSpan(s: string): Span | null {
  let best: Span | null = null;
  for (const f of SPAN_FINDERS) {
    const sp = f(s);
    if (sp && (!best || sp.pos < best.pos)) best = sp;
  }
  return best;
}

/**
 * Inline spans: `code`, **bold**, *italic*, [text](url).
 * Text between spans is emitted as plain strings — Preact renders string children as
 * text nodes, so raw HTML in the source can never inject markup.
 */
function inline(s: string, keyBase: string): ComponentChildren[] {
  const out: ComponentChildren[] = [];
  let rest = s;
  let k = 0;
  while (rest.length) {
    const sp = firstSpan(rest);
    if (!sp) {
      out.push(rest);
      break;
    }
    if (sp.pos > 0) out.push(rest.slice(0, sp.pos));
    out.push(sp.render(keyBase, k++));
    rest = rest.slice(sp.next);
  }
  return out;
}

function para(lines: string[], key: string): VNode {
  return (
    <p key={key}>
      {lines.map((l, i) => (
        <>
          {i ? <br key={`${key}br${i}`} /> : null}
          {inline(l, `${key}l${i}`)}
        </>
      ))}
    </p>
  );
}

type BlockParser = (lines: string[], i: number, key: string) => { node: VNode; next: number } | null;

function fenceBlock(lines: string[], i: number, key: string) {
  if (!lines[i].trim().startsWith("```")) return null;
  const code: string[] = [];
  let j = i + 1;
  while (j < lines.length && !lines[j].trim().startsWith("```")) code.push(lines[j++]);
  return { node: <pre key={key}><code>{code.join("\n")}</code></pre>, next: j + 1 };
}

function headingBlock(lines: string[], i: number, key: string) {
  const h = /^(#{1,6})\s+(.*)$/.exec(lines[i].trim());
  if (!h) return null;
  const lvl = Math.min(h[1].length, 6);
  return { node: <div key={key} class={`md-h md-h${lvl}`}>{inline(h[2], `${key}t`)}</div>, next: i + 1 };
}

function tableHead(key: string, head: string[]): VNode {
  return (
    <thead>
      <tr>
        {head.map((c, ci) => <th key={`${key}h${ci}`}>{inline(c, `${key}h${ci}c`)}</th>)}
      </tr>
    </thead>
  );
}

function tableBody(key: string, head: string[], rows: string[][]): VNode {
  return (
    <tbody>
      {rows.map((r, ri) => (
        <tr key={`${key}r${ri}`}>
          {head.map((_, ci) => <td key={`${key}r${ri}c${ci}`}>{inline(r[ci] ?? "", `${key}r${ri}c${ci}i`)}</td>)}
        </tr>
      ))}
    </tbody>
  );
}

function tableBlock(lines: string[], i: number, key: string) {
  if (!lines[i].trim().startsWith("|") || cells(lines[i]).length < 2 || i + 1 >= lines.length || !isSepRow(lines[i + 1])) return null;
  const head = cells(lines[i]);
  let j = i + 2;
  const rows: string[][] = [];
  while (j < lines.length && lines[j].trim().startsWith("|")) rows.push(cells(lines[j++]));
  return {
    node: (
      <div key={key} class="md-table-wrap">
        <table class="md-table">{tableHead(key, head)}{tableBody(key, head, rows)}</table>
      </div>
    ),
    next: j,
  };
}

function listBlock(re: RegExp, Tag: "ul" | "ol"): BlockParser {
  return (lines, i, key) => {
    if (!re.exec(lines[i])) return null;
    const items: string[] = [];
    let j = i;
    while (j < lines.length) {
      const m = re.exec(lines[j]);
      if (!m) break;
      items.push(m[1]);
      j++;
    }
    return {
      node: <Tag key={key}>{items.map((it, ii) => <li key={`${key}i${ii}`}>{inline(it, `${key}i${ii}c`)}</li>)}</Tag>,
      next: j,
    };
  };
}

const BLOCKS: BlockParser[] = [fenceBlock, headingBlock, tableBlock, listBlock(/^ *[-*+]\s+(.*)$/, "ul"), listBlock(/^ *\d+[.)]\s+(.*)$/, "ol")];

function matchBlock(lines: string[], i: number, key: string) {
  for (const b of BLOCKS) {
    const r = b(lines, i, key);
    if (r) return r;
  }
  return null;
}

/**
 * A deliberately small Markdown subset for agent replies: fenced code, headings,
 * pipe tables, bullet/numbered lists, paragraphs, and inline `code`/bold/italic/links.
 * Unknown lines fall back to paragraphs, so the input never throws or injects HTML.
 */
export function renderMarkdown(src: string): VNode[] {
  const out: VNode[] = [];
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  const paraBuf: string[] = [];
  let n = 0;
  const flush = () => {
    if (paraBuf.length) {
      out.push(para(paraBuf, `p${n++}`));
      paraBuf.length = 0;
    }
  };
  let i = 0;
  while (i < lines.length) {
    const key = `m${n++}`;
    const block = matchBlock(lines, i, key);
    if (block) {
      flush();
      out.push(block.node);
      i = block.next;
      continue;
    }
    if (!lines[i].trim()) {
      flush();
      i++;
      continue;
    }
    paraBuf.push(lines[i].trim());
    i++;
  }
  flush();
  return out;
}
