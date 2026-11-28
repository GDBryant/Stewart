import { stringify } from "yaml";
import type { Store } from "./state.js";
import type { ChannelSummary } from "./bridge.js";
import { looksLikeKey } from "./fields.js";
import { ChannelSecurity } from "./channelSecurity.js";

type TestResult = { ok: boolean; models?: string[]; error?: string; reasoning?: { suggest?: "reasoning_effort" | "enable_thinking" | "none"; control?: boolean } };

function ReasoningNote({ reasoning }: { reasoning: TestResult["reasoning"] }) {
  if (!reasoning) return null;
  if (reasoning.control === true) return <span class="ok" title="The configured reasoning request field demonstrably cuts reasoning tokens">· reasoning field works</span>;
  if (reasoning.control === false) return <span class="fail" title="The configured reasoning request field did not cut reasoning tokens on the probed model">· reasoning field ineffective</span>;
  if (reasoning.suggest === "reasoning_effort" || reasoning.suggest === "enable_thinking") {
    return <span class="warn" title={`Probing the first model shows ${reasoning.suggest} controls reasoning — set it in the channel editor`}>· reasoning: set {reasoning.suggest}</span>;
  }
  if (reasoning.suggest === "none") return <span class="hint" title="The probed model reasons, but neither reasoning_effort nor enable_thinking controlled it">· no working reasoning field found</span>;
  return null;
}

function ChannelTestBadge({ test }: { test?: TestResult }) {
  if (!test) return null;
  if (test.ok) {
    return (
      <span class="ok">
        ✓ {(test.models ?? []).join(", ")}
        <ReasoningNote reasoning={test.reasoning} />
      </span>
    );
  }
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
    <>
      <div class="ch-status">
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
      </div>
      <ChannelSecurity item={item} store={store} />
    </>
  );
}
