# @stewart/agent-loop

- Purpose: The tool loop, the one session builder, fault classification, and the run-runtime contract
- Surface: `src/api.ts`
- Owns: `toolLoop.ts` (`ToolLoop` stream → parse → execute), `loopTypes.ts`, `session.ts` (`createAgentSession`, the only `new ToolLoop(`), `faults.ts` (`classifyFault`, `detectStuck`), `runtime.ts` (`OrchestrationRuntime`/`RunRuntime`, `RoleTaskDeps`, `TaskResult`, `RecoveryState`, `Recovery` interface)
- Depends on: `@stewart/budget`, `@stewart/channels`, `@stewart/compaction`, `@stewart/config`, `@stewart/interaction`, `@stewart/kernel`, `@stewart/ledger`, `@stewart/models`, `@stewart/permissions`, `@stewart/protocol`, `@stewart/roles-skills`, `@stewart/run-state`, `@stewart/scheduling`, `@stewart/toolcall-format`, `@stewart/tools` (lower layers only; `scripts/layers.json`)
- Fake it: Drive `createAgentSession` with a scripted `ManagedChannel` and stub tools; build an `OrchestrationRuntime` literal with `fakeHost()` and `{ emit }`
