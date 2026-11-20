# @stewart/business-policy

- Purpose: Outbound content rules (passwords, privacy): detect secrets/private data in messages before they leave the machine
- Surface: `src/api.ts` (`checkOutbound`, `applyOutbound`, `describeViolation`, `RULES`, `RULE_IDS`)
- Owns: the rules (one file each in `src/rules/`), the registry (duplicate ids throw), `Violation`/`Outbound` types. Never returns matched text.
- Depends on: `@stewart/kernel` only
- Fake it: pass plain `ChatMessage[]` to `applyOutbound`; no I/O
