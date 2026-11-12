# @stewart/session

- Purpose: one chat session per conversation — persisted transcript (tool results included), lead-role turn through an engine, after-turn code check, cost metering.
- Surface: `src/api.ts` — `SessionService` (`send`, `cancel`), `SessionDeps`, `SendRequest`.
- Owns: transcript load/save via `ChatHistoryStore` (`<stateDir>/history`), engine state (`<stateDir>/sessions/<id>.engine.json`), system prompt (lead prompt + skill index + bounded project notes), session tools `load_skill`/`ask_user`, `check.result` + `run.finished` status from engine reason and check.
- Depends on: `@stewart/engines`, `@stewart/tasks`, `@stewart/run-state`, `@stewart/roles-skills`, `@stewart/context`, `@stewart/config`, `@stewart/interaction`, `@stewart/permissions`, `@stewart/ledger`, `@stewart/tools`, `@stewart/kernel`, `@stewart/protocol`, `@stewart/channels`.
- Fake it: `fakeHost` + scripted engine via `engineFor` dep override; collect bus events until `run.finished`.
