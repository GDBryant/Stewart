# Tasks

1. [ ] Add bounded setup smoke-probe contract, scheduler, cancellation, and 30-second timeout (core/setup module).
2. [ ] Implement provider-aware minimal chat smoke requests for OpenAI-compatible, Ollama, and Claude CLI channels.
3. [ ] Build deterministic Ollama/Claude-first candidate order and bounded evaluator usefulness ranking.
4. [ ] Add protocol types and VS Code/JetBrains host routing for probe start/status/cancel.
5. [ ] Feed ordered green candidates and evaluator ranking into setup recommendation; preserve rules fallback and hard-requirement checks.
6. [ ] Add wizard status UI and top-level Accept and continue control.
7. [ ] Add positive and negative tests across setup, core, protocol, hosts, and webview.
8. [ ] Update SETUP.md and ARCHITECTURE_NOW.md; run focused tests, typecheck, and manual smoke verification.

## Checkpoints
- [ ] After tasks 1-2: timeout, cancellation, and provider request behavior are covered by focused tests.
- [ ] After tasks 3-4: ordering/ranking and both host routes are covered by focused tests.
- [ ] After tasks 5-6: recommendation and wizard UX work end-to-end with partial results.
- [ ] Before completion: full relevant test/typecheck/layer checks pass and docs are current.
