# @stewart/runs

- Purpose: Run lifecycle: one pipeline, three strategies, approvals/asks, journal, revert, slash commands
- Surface: `src/api.ts`
- Owns: `service.ts` (`RunService`: run map, grants + approval gate, `prompt` binding onto the project `Interaction`, ledger/history, journal, revert), `direct.ts`/`orchestrated.ts`/`resume.ts` (strategy objects), `runtime.ts` (`buildRunRuntime`), `parseCommand.ts` (`parseChatCommand`), `consts.ts`
- Depends on: `@stewart/agent-loop`, `@stewart/budget`, `@stewart/channels`, `@stewart/config`, `@stewart/context`, `@stewart/interaction`, `@stewart/kernel`, `@stewart/ledger`, `@stewart/orchestration`, `@stewart/permissions`, `@stewart/protocol`, `@stewart/recovery`, `@stewart/roles-skills`, `@stewart/run-state`, `@stewart/scheduling` (lower layers only; `scripts/layers.json`)
- Fake it: `new RunService({ host: fakeHost(), clock, ids: counterIds(), bus: { emit } })` with scripted `ManagedChannel`s; assert on `RunEvent`s
