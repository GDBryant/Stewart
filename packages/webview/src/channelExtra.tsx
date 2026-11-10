import { stringify } from "yaml";
import type { Store } from "./state.js";
import type { ChannelSummary } from "./bridge.js";
import { looksLikeKey } from "./fields.js";

function ChannelTestBadge({ test }: { test?: { ok: boolean; models?: string[]; error?: string } }) {
  if (!test) return null;
  if (test.ok) return <span class="ok">✓ {(test.models ?? []).join(", ")}</span>;
  return <span class="fail">✗ {test.error}</span>;
}

function ChannelSecretBlock({ secretRef, stored, onClear }: { secretRef?: string; stored: boolean; onClear(): void }) {
  if (!secretRef) return null;
  return (
    <span class="secret">
      {stored ? <span class="ok">key stored</span> : <span class="hint">no key stored</span>}
      {stored ? <button class="small deny" onClick={onClear}>Clear key</button> : null}
    </span>
  );
}

export function ChannelExtra({ item, store }: { item: ChannelSummary; store: Store }) {
  const test = store.state.channelTest[item.id];
  const ref = item.secretRef;
  const stored = ref ? store.state.config?.secrets?.[ref] : undefined;
  const leaked = !!ref && looksLikeKey(ref);
  const moveToStore = () => {
    if (!ref) return;
    const newRef = `channel-${item.id}`;
    store.setSecret(newRef, ref);
    const items = (store.state.config?.summary.channels ?? []).map((c) => (c.id === item.id ? { ...c, secretRef: newRef } : c));
    store.saveFile("channels.yaml", stringify({ version: 1, items }, null, 2));
  };
  return (
    <span class="extra">
      <ChannelTestBadge test={test} />
      <button class="small" onClick={() => store.testChannel(item.id)}>Test</button>
      {leaked ? (
        <span class="fail">
          API key is saved as plain text in channels.yaml.{" "}
          <button class="small" onClick={moveToStore}>Move to secret store</button>
        </span>
      ) : (
        <ChannelSecretBlock secretRef={ref} stored={!!stored} onClear={() => ref && store.deleteSecret(ref)} />
      )}
    </span>
  );
}
