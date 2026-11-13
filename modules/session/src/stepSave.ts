/**
 * Single-flight step saver: at most one save in flight; steps that arrive while it runs coalesce into exactly
 * one more save afterwards. save() always reads live state at call time, so a later compaction is never
 * overwritten by an earlier snapshot.
 */
export function stepSaver(save: () => Promise<void>): () => void {
  let running = false;
  let more = false;
  return () => {
    if (running) {
      more = true;
      return;
    }
    running = true;
    void (async () => {
      do {
        more = false;
        await save().catch(() => {});
      } while (more);
      running = false;
    })();
  };
}
