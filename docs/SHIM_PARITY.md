# Shim parity — Python reference vs Kotlin port

Python source: `/srv/compose/aif_shim` rev `c35a654`.

| File | SHA-256 |
|------|---------|
| `aif_shim/parser.py` | `7b648e171cfd4fb0fc742685301b4c618a4a361019d7912ca13b19a64014fd90` |
| `aif_shim/translate.py` | `ac74c3d3e3b2cfbeb4878b30368934313e105cecdcbf84fef740fad9d6773532` |
| `tests/test_parser.py` | `405e75353e4acd4710a10b3e06fe197959f27ce751f8912e7fc2c924cb22b241` |
| `tests/test_translate.py` | `40395938d254be474752f7cf4cdfa262f9ff4ed763f65f9cd4e1612d4d86e724` |

## Function map

| Python | Kotlin |
|--------|--------|
| `parse_tool_calls` | `ToolCallParser.parseToolCalls` |
| `_strip_think` / `_coerce` / `_repair_json` / `_closes_string` / `_quote_bare_value` / `_clean_json_block` | private members of `ToolCallParser` |
| `raw_decode` | `ToolCallParser.firstJsonValueEnd` + `strictDecode` |
| `repair_native_call` | `ToolCallParser.repairNativeCall` |
| `call_tag` / `build_tool_block` / `request_tools` / `prepare_request` / `_merge_messages` | `RequestTranslator` (callTag/toolBlock/offeredTools/prepare/mergeMessages) |
| `needs_retry` / `is_empty_turn` / `tool_policy_error` / `tool_calls_required` / `add_retry_nudge` | `RequestTranslator` (needsRetry/isEmptyTurn/toolPolicyError/toolCallsRequired/retryNudge+mergeMessages) |
| `StreamTranslator` / `NativeCallCollector` | same names in `shim` |
| `convert_response` behaviour | `ToolCallingProvider.chat` |
| `ToolCallParseError` | `ToolCallParseException` (same `code` values) |

## Intentional differences

1. Alias normalisation targets `RunTerminal` with `{"command": <str>}` (single command only);
   aliases = Python `_EXEC_ALIASES` + `run_commands`. Otherwise the call is untouched.
2. A call tag inside an outer ``` fenced region (odd ``` count before it, offset by
   `startInFence`) or immediately preceded by a backtick is text, not a call. A ```
   inside a `<tool_call>` block keeps Python behaviour.
3. `split_tool_text` (drop/reasoning modes) is not ported — text alongside calls is kept.
4. `strictDecode` additionally rejects bare non-JSON literals (`a.py`) that
   `kotlinx.serialization` would accept but Python's `json.loads` rejects.

## Skipped Python tests (not applicable)

`test_convert_response*` (server-side dict rewrite, superseded by ToolCallingProvider
tests covering the same behaviours), `test_split_tool_text_modes`,
`test_stream_translator_buffer_all` (buffer_all not ported), `caplog` assertions
(`test_unparseable_block_logs_failure_code_and_stays_in_text`,
`test_json_arguments_unterminated_string_rejected`, `test_failure_codes_logged` — codes
exist but we don't log via Python logging), `test_tools_injected_into_system_list`
(list-typed content not supported by ChatMessage), `test_add_retry_nudge_*` shape tests
(covered via mergeMessages), `test_needs_retry_reads_list_content` (list content).
