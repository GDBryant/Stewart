# Claude Code CLI feasibility spike

Decides whether the Claude Code CLI subprocess is a viable authenticated transport for
enterprise SSO accounts. Gate rule from `PLAN.md`: a failed gate blocks M3 (Claude
provider) only — Ollama/AIF work continues.

## How to run

Requires `claude` on PATH and an interactive enterprise login already performed
(`claude` interactive session once, or the organisation's login procedure).

```bash
./scripts/claude-feasibility.sh
```

The script creates a disposable `mktemp -d` workspace with a sentinel file, runs the
candidate invocation from PLAN.md

```
claude -p --output-format stream-json --verbose --include-partial-messages \
    --tools "" --safe-mode --strict-mcp-config --no-session-persistence
```

with a prompt asking the model to create files and run a command, captures the
stream-json output, then runs a second plain prompt to confirm authentication.
It prints PASS/FAIL per check and the log paths. JSON events are parsed with `jq`
when present, otherwise `python3`; the script exits if neither is available. Do not
run it in CI — it uses the enterprise account.

## Checks

| # | Check | Result |
|---|-------|--------|
| 1 | CLI version recorded (`claude --version`) | PASS — 2.1.309 (2026-10-26) |
| 2 | Enterprise SSO login works (plain prompt exit 0, final `result` event `is_error=false`) | PASS |
| 3 | stream-json partial deltas present (`stream_event` / `content_block_delta`) | PASS |
| 4 | `system`/`init` event has empty `tools` and `mcp_servers` arrays | PASS |
| 5 | No built-in tool execution (`tool_use` blocks absent; `pwned.txt`/`ran.txt` not created; sentinel unchanged) | PASS |
| 6 | Hooks/plugins/MCP suppressed under effective managed policy — manually inspect managed settings (`claude` config directories / organisation policy file) before trusting `--safe-mode` | pending (manual) |

## Outcome

- PASS on all checks → record the supported CLI version in PLAN.md/COMPATIBILITY.md,
  proceed with M3.
- Any FAIL → disable this transport and revisit the design (see PLAN.md open
  question 1). M3 is blocked; M2/M4+ are not.

Result (2026-10-26): all scripted checks PASS on CLI 2.1.309 with the enterprise
account. Check 6 (managed policy / hooks suppression) still needs a manual look at
the organisation's managed settings before M3 ships.