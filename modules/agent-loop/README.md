# @stewart/agent-loop

- Purpose: The tool loop, the one session builder, fault classification
- Surface: `src/api.ts`
- Owns: `toolLoop.ts` (`ToolLoop` stream → parse → execute), `loopTypes.ts`, `session.ts` (`createAgentSession`, the only `new ToolLoop(`), `faults.ts` (`classifyFault`, `detectStuck`)
- Depends on: `@stewart/budget`, `@stewart/channels`, `@stewart/compaction`, `@stewart/config`, `@stewart/kernel`, `@stewart/ledger`, `@stewart/models`, `@stewart/permissions`, `@stewart/protocol`, `@stewart/roles-skills`, `@stewart/toolcall-format`, `@stewart/tools` (lower layers only; `scripts/layers.json`)
- Fake it: Drive `createAgentSession` with a scripted `ManagedChannel` and stub tools; the run runtime literal lives in `@stewart/run-contract`
