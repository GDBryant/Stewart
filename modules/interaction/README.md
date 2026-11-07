# @stewart/interaction

- Purpose: The one owner of user-facing prompt cards: approvals and ask_user, with timeout/abort withdraw
- Surface: `src/api.ts`
- Owns: `interaction.ts` (`Interaction`: `approval`, `ask`, `askTimed`, `resolveApproval`, `resolveAnswer`; emits `approval.request`/`ask_user`/`question.withdrawn`)
- Depends on: `@stewart/kernel`, `@stewart/protocol` (lower layers only; `scripts/layers.json`)
- Fake it: Construct with `counterIds()`, a stub `Clock` and `{ emit: (e) => events.push(e) }`; resolve cards by id from the captured events
