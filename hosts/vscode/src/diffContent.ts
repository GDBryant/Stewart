const MAX_ENTRIES = 50;

/** Contents backing the `stewart-diff:` scheme: read-only virtual documents for diff sides, latest MAX kept. */
export class DiffContent {
  private readonly docs = new Map<string, string>();
  private seq = 0;

  /** Stores `content` for one side of a `path` diff; returns the `stewart-diff:` uri string for it. */
  put(side: "before" | "after", path: string, content: string): string {
    const key = String(this.seq++);
    this.docs.set(key, content);
    if (this.docs.size > MAX_ENTRIES) this.docs.delete(this.docs.keys().next().value!);
    const name = path.split("/").pop() ?? path;
    return `stewart-diff://diff/${key}/${encodeURIComponent(side)}-${encodeURIComponent(name)}`;
  }

  /** Content for a `stewart-diff:` uri string, tolerant of uri re-encoding; undefined when unknown. */
  get(uri: string): string | undefined {
    const key = /^stewart-diff:\/\/diff\/(\d+)\//.exec(uri)?.[1];
    return key === undefined ? undefined : this.docs.get(key);
  }
}
