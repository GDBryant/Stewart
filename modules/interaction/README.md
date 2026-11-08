# @stewart/interaction

- Purpose: The one owner of user-facing prompts: a FIFO queue showing one card at a time, with typed `Prompt<A>` and timeout/abort withdraw
- Surface: `src/api.ts`
- Owns: `interaction.ts` (`Interaction`: `ask`, `withdraw`, `resolveApproval`, `resolveAnswer`, `pending`; `Prompt<A>`, `PromptOutcome`, `PromptView`, `approvalPrompt`, `questionPrompt`; emits `approval.request`/`ask_user`/`question.withdrawn`)
- Depends on: `@stewart/kernel`, `@stewart/protocol` (lower layers only; `scripts/layers.json`)
- Fake it: Construct with `counterIds()`, a stub `Clock` and `{ emit: (e) => events.push(e) }`; resolve the shown card by id from captured events. Runtime consumers: a scripted `prompt: async (p) => ({ kind: "answered", value: p.decode("…") })`
