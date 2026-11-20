# Business policy (outbound content rules) — plan

Status: accepted (open questions resolved in §5). Replaces the stub `docs/business_layer_2026-11-16.md` (requirement: checks that block outgoing messages containing passwords or private data; ticked on/off per channel; start with password + privacy rules).

## 1. Evaluation

The requirement is a **content** gate on what leaves the machine. The existing policy layer is an **action** gate:

| | Policy layer today | Business policy (new) |
|---|---|---|
| Question | may this role do this tool action? | may this text be sent to this channel? |
| Where | `tools/policy.ts` `decide(role, action)` via `policyApprove`; `permissions.gate` prompts | nowhere yet |
| Input | tool name + args/preview | outgoing messages (system, user, tool results, images) |
| Scope | per role / per project | per channel |

They share a shape (deterministic check → allow/deny + reason, fail closed, evidence on denial) but not an input, so they are **not one function**. Merge them at the *seam and vocabulary* level, not the code level:

- one module owns rule evaluation and one result type;
- one wiring point per egress path;
- denials surface the same way as `policy_violation` (check evidence, run fails, no silent drop);
- one settings home and one doc (`PERMISSIONS.md` gains a "Business policy" section).

### Egress paths found (all must be covered, or the rule is theatre)

1. **Native loop** (openai/ollama channels): every request goes through `ManagedChannel.chat(req)` (`modules/channels/src/registry.ts:92`). Single choke point. Carries user text, pasted/attached content, **tool results** (file reads, command output — the main leak vector).
2. **claude-code engine**: spawns the CLI and writes the user line + recap to stdin (`modules/engines/src/claudeCode.ts`); it does *not* use `ManagedChannel.chat`. Needs its own check at the stdin write.
3. **`engine.complete`** (function roles, `claudeComplete`): separate path; covered by the same two seams if rules run in `ManagedChannel` and in `claudeComplete`.
4. **Known gap (document, do not hide):** the Claude CLI reads project files and runs tools *itself*; Stewart cannot see that content before the CLI sends it. Business policy for `claude-cli` channels can only check what Stewart sends it. The setting must say so. Handled by the refuse-and-ask rule in §5.4.

## 2. Design

### New module `@stewart/business-policy` (layer 3, deps: `kernel` only)

```
checkOutbound(messages: ChatMessage[], rules: RuleId[]) -> Violation[]
Violation = { rule: RuleId; where: "system"|"user"|"tool"|"assistant"; msgIndex: number; hint: string }   // never contains the matched secret
RULES: Record<RuleId, Rule>       // one file per rule, registry rejects duplicate ids
```

Rule v1 (one file each, positive + negative fixtures):
- `passwords`: `password|passwd|pwd|secret|token|api[_-]?key` assigned a value (`key=value`, `"key": "value"`, `export X=`), `Authorization: Bearer …`, private key blocks (`-----BEGIN … PRIVATE KEY-----`), URLs with `user:pass@`, well-known token shapes (AWS `AKIA…`, GitHub `ghp_…`, `sk-…`, JWT). Skip obvious placeholders (`<your-password>`, `changeme`, `***`, `${VAR}`).
- `privacy`: email addresses, phone numbers, national-ID/SSN-style numbers, payment-card numbers (Luhn-validated to cut false positives), IBAN. Conservative regex + validators; no ML.

Rules are pure `(text) => hit[]`; `checkOutbound` walks text parts only (images are not inspected in v1 — stated limit).

### Decision shape (the merge point)

`checkOutbound` result maps onto the existing evidence path: a violation throws `BusinessPolicyError` at the seam; the task runner records evidence `business_policy: blocked outgoing message to <channel>: <rule> in <where> #<n> (<hint>)` and the run/attempt **fails without escalating to another agent on the same channel** (escalating to a channel with the rule off is allowed — the rule is per channel). Same surfacing as `policy_violation` in `taskRun.ts` verify; `run.finished` failure text carries it. No raw match in logs, events or debug sink (reuse `diagnostics` redaction).

### Config (settings.yaml, not channels.yaml)

The rule matrix is one business decision, edited in one place, so it lives in settings:

```yaml
businessPolicy:
  rules:                # which rules exist/are enabled globally
    passwords: true
    privacy: true
  channels:             # per-channel override; absent channel = rules.* defaults
    ollama-local: { passwords: false, privacy: false }   # local model: nothing leaves the machine
```

Zod in `modules/config/src/schema.ts` (`businessPolicy` with defaults `{rules:{passwords:true,privacy:true},channels:{}}`). Default **on** for all channels (fail safe); local `ollama` channels are *suggested* off in the UI but not defaulted off. Unknown channel ids in `channels` are ignored on load (stale after delete) and pruned on save.

### Wiring

- `ManagedChannel` gets an optional `guard: (req) => void` set by `ChannelService.rebuild` from `EffectiveConfig` (so config reload re-applies; limiter state already survives reloads — follow that pattern). Called at the top of `chat()` before `acquire()` so a blocked request holds no slot and does not trip the breaker (`BusinessPolicyError` is not a channel failure).
- claude-code: `engines/claudeCode.ts` calls the same `guard` on the stdin line and recap before spawn; `claudeComplete` likewise.
- Core exposes the effective rules per channel through the existing config handler; no new RPC beyond the settings save (`saveFile settings.yaml`).

## 3. Settings UI

`Settings → settings` tab (`packages/webview/src/settingsEditor.tsx`, currently a flat field list) gains a **Business policy** section below the existing fields:

- Table: rows = enabled channels (colour dot via `channelColors`), columns = `Passwords`, `Privacy` checkboxes; header row = global default toggles.
- Hint text: what each rule blocks; the claude-cli limitation; "blocked messages fail the run, nothing is sent".
- Saves through the same `settingsYaml()` path. `settingsYaml` currently keeps unshown top-level keys by name — `businessPolicy` must be added to the shown set (and `unflatten` must support the nested map), or the section gets its own component writing only that key. Prefer the separate component `businessPolicySection.tsx` (settingsEditor is small; keep files <300 lines).
- Setup wizard: out of scope for v1; wizard-created channels inherit defaults (on).

## 4. Build order (each step ships tests, positive + negative; docs in the same commit)

| # | Step | Verify |
|---|---|---|
| B1 | `@stewart/business-policy` module (`new-module.mjs`, add to `layers.json`), `passwords` rule + registry + redacted `Violation` | unit fixtures: real shapes hit, placeholders/prose don't; match never in output |
| B2 | `privacy` rule (Luhn, email, phone, IBAN, ID) | fixtures incl. false-positive negatives (version strings, UUIDs, line numbers) |
| B3 | Config schema `businessPolicy` + defaults + prune + migration-free load | loader tests: absent block = defaults, unknown channel dropped, bad type rejected |
| B4 | `ManagedChannel` guard + `ChannelService` wiring; blocked request holds no slot, no breaker failure | channels tests: blocked/allowed, per-channel off, reload re-applies |
| B5 | claude-code + `claudeComplete` guard; `business_policy` evidence in `taskRun`/`turnState`, no same-channel escalation | engines/session tests: run fails with evidence, escalation to rule-off channel proceeds |
| B6 | Webview section + save path | `app.test.tsx`: toggles persist, unknown keys preserved, claude-cli hint shown |
| B7 | Docs: `ARCHITECTURE_NOW.md` (module table, egress, config), `PERMISSIONS.md` section, `AGENTS.md` reference, delete `business_layer_2026-11-16.md` | `check:docs`, `check:layers`, `check:functions`, coverage ≥90/80 |

Keep each function within the limits (≤40 lines, complexity ≤10): one file per rule keeps this natural.

## 5. Decisions (user, 2026-11-20)

1. **User/system/assistant content: block and notify.** The request is not sent; the attempt fails with `business_policy` evidence and the user sees a chat notice naming channel, rule and message position (never the matched text).
2. **Tool results: withhold that result, continue, notify.** The offending tool message content is replaced by `[output withheld by business policy: <rule>]` in the outgoing request copy only (the persisted transcript keeps the original; the replacement is re-applied each request). The run continues; the user gets a notice per withheld result. claude-code recap: same replacement on the tool-result excerpts.
3. **Custom patterns: later.** Out of scope.
4. **`claude-cli` channels with rules ticked: refuse and ask.** Run start on such a channel raises an `ask_user` card: "Channel <id> uses the Claude CLI, which reads files itself; business policy can only check what Stewart sends. Continue anyway, or stop?" with options `["Continue", "Stop"]`. `Stop`/timeout fails the run (`business_policy: refused …`); `Continue` is remembered for that session + channel (memory only, reset on core restart) and checks on Stewart's own sends still apply. Delegated children cannot prompt: they inherit the lead session's answer, else return `status: failed` with the refusal evidence.

### Notification mechanism

New protocol event `policy.notice {runId, channel, rule, action: "blocked"|"withheld"|"refused", where, msgIndex}` (both hosts forward unchanged; the webview renders a warning row in the run). Invariant: no field carries matched text; tested for every rule.

## 6. Build-order changes from the decisions

- B4 adds the tool-result withhold (pure `applyOutbound(messages, rules) -> {messages, blocked, withheld}`; the guard throws only when `blocked` is non-empty) and emits `policy.notice`.
- B5 adds the claude-cli ask (existing interaction question prompt, same pattern as the turn-limit Continue/Stop card) and the session+channel memory of `Continue`.
- B6 webview renders `policy.notice`; the claude-cli hint says "asks before each session".
- New tests: tool result withheld and run continues; user text blocks; notice carries no matched text; Continue remembered, Stop fails, child inherits the answer.
