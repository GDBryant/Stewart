# @stewart/tasks

- Purpose: per-turn acceptance checks run by code (file existence/read-back, command exit, non-empty reply).
- Surface: `src/api.ts` — `Check`, `WriteRecord`, `CheckInput`, `CheckResult`, `turnCheck`, `runCheck`.
- Owns: the definition of "done" for a lead turn; evidence strings for pass/fail.
- Depends on: `@stewart/kernel` (HostPort files/proc slices).
- Fake it: `fakeHost` from `@stewart/kernel` testing — seed `files`, drive `setProcHandler` for command exits/timeouts.
