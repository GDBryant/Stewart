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
    const cb = rest.indexOf("`");
    const ce = cb >= 0 ? rest.indexOf("`", cb + 1) : -1;
    const bb = rest.indexOf("**");
    const be = bb >= 0 ? rest.indexOf("**", bb + 2) : -1;
    const ib = singleStar(rest);
    const ie = ib >= 0 ? rest.indexOf("*", ib + 1) : -1;
    const lb = rest.indexOf("[");
    const lt = lb >= 0 ? rest.indexOf("](", lb) : -1;
    const le = lt >= 0 ? rest.indexOf(")", lt) : -1;
    const starts = [ce > cb ? cb : -1, be > bb ? bb : -1, ie > ib ? ib : -1, le > lt ? lb : -1];
    let pick = -1;
    let pos = -1;
    for (let b = 0; b < starts.length; b++) {
      if (starts[b] >= 0 && (pos < 0 || starts[b] < pos)) {
        pos = starts[b];
        pick = b;
      }
    }
    if (pick < 0) {
      out.push(rest);
      break;
    }
    if (pos > 0) out.push(rest.slice(0, pos));
    if (pick === 0) {
      out.push(<code key={`${keyBase}c${k++}`}>{rest.slice(cb + 1, ce)}</code>);
      rest = rest.slice(ce + 1);
    } else if (pick === 1) {
      out.push(<strong key={`${keyBase}s${k++}`}>{inline(rest.slice(bb + 2, be), `${keyBase}st${k}`)}</strong>);
      rest = rest.slice(be + 2);
    } else if (pick === 2) {
      out.push(<em key={`${keyBase}e${k++}`}>{inline(rest.slice(ib + 1, ie), `${keyBase}em${k}`)}</em>);
      rest = rest.slice(ie + 1);
    } else {
      out.push(
        <a key={`${keyBase}a${k++}`} href={safeUrl(rest.slice(lt + 2, le))} target="_blank" rel="noreferrer noopener">
          {rest.slice(lb + 1, lt)}
        </a>,
      );
      rest = rest.slice(le + 1);
    }
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
    const line = lines[i];
    const key = `m${n++}`;
    if (line.trim().startsWith("```")) {
      flush();
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith("```")) code.push(lines[i++]);
      i++;
      out.push(<pre key={key}><code>{code.join("\n")}</code></pre>);
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line.trim());
    if (h) {
      flush();
      const lvl = Math.min(h[1].length, 6);
      out.push(<div key={key} class={`md-h md-h${lvl}`}>{inline(h[2], `${key}t`)}</div>);
      i++;
      continue;
    }
    if (line.trim().startsWith("|") && cells(line).length >= 2 && i + 1 < lines.length && isSepRow(lines[i + 1])) {
      flush();
      const head = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) rows.push(cells(lines[i++]));
      out.push(
        <div key={key} class="md-table-wrap">
          <table class="md-table">
            <thead>
              <tr>
                {head.map((c, ci) => <th key={`${key}h${ci}`}>{inline(c, `${key}h${ci}c`)}</th>)}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={`${key}r${ri}`}>
                  {head.map((_, ci) => <td key={`${key}r${ri}c${ci}`}>{inline(r[ci] ?? "", `${key}r${ri}c${ci}i`)}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }
    const ul = /^ *[-*+]\s+(.*)$/.exec(line);
    if (ul) {
      flush();
      const items: string[] = [];
      while (i < lines.length) {
        const m = /^ *[-*+]\s+(.*)$/.exec(lines[i]);
        if (!m) break;
        items.push(m[1]);
        i++;
      }
      out.push(<ul key={key}>{items.map((it, ii) => <li key={`${key}i${ii}`}>{inline(it, `${key}i${ii}c`)}</li>)}</ul>);
      continue;
    }
    const ol = /^ *\d+[.)]\s+(.*)$/.exec(line);
    if (ol) {
      flush();
      const items: string[] = [];
      while (i < lines.length) {
        const m = /^ *\d+[.)]\s+(.*)$/.exec(lines[i]);
        if (!m) break;
        items.push(m[1]);
        i++;
      }
      out.push(<ol key={key}>{items.map((it, ii) => <li key={`${key}i${ii}`}>{inline(it, `${key}i${ii}c`)}</li>)}</ol>);
      continue;
    }
    if (!line.trim()) {
      flush();
      i++;
      continue;
    }
    paraBuf.push(line.trim());
    i++;
  }
  flush();
  return out;
}
