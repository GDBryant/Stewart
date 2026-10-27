package com.aijb.assistant

import com.aijb.assistant.provider.ToolCall
import com.aijb.assistant.provider.RawToolCall
import com.aijb.assistant.shim.ToolCallParseException
import com.aijb.assistant.shim.ToolCallParser
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class ToolCallParserTest {

    private val json = Json { ignoreUnknownKeys = true }

    private fun schema(vararg spec: Pair<String, JsonObject>): Map<String, JsonObject> = mapOf(*spec)

    private fun props(vararg kv: Pair<String, String>): JsonObject = JsonObject(
        mapOf("properties" to JsonObject(kv.associate { (k, t) -> k to JsonObject(mapOf("type" to JsonPrimitive(t))) }))
    )

    private val SCHEMA = schema(
        "read_file" to props("path" to "string"),
        "run_commands" to props("command" to "string", "count" to "integer"),
        "list_files" to props("path" to "string"),
    )

    private fun namesArgs(calls: List<ToolCall>): List<Pair<String, JsonObject>> =
        calls.map { it.name to it.arguments }

    private fun args(vararg kv: Pair<String, kotlinx.serialization.json.JsonElement>) = JsonObject(mapOf(*kv))

    private fun s(v: String) = JsonPrimitive(v)
    private fun n(v: Int) = JsonPrimitive(v)
    private fun b(v: Boolean) = JsonPrimitive(v)

    @Test
    fun `hermes json`() {
        val text = "Let me read it.\n<tool_call>\n{\"name\": \"read_file\", \"arguments\": {\"path\": \"a.py\"}}\n</tool_call>"
        val (clean, calls, reasoning) = ToolCallParser.parseToolCalls(text, SCHEMA)
        assertEquals("Let me read it.", clean)
        assertEquals(listOf("read_file" to args("path" to s("a.py"))), namesArgs(calls))
        assertTrue(calls[0].id.startsWith("call_"))
        assertNull(reasoning)
    }

    @Test
    fun `qwen3 coder xml`() {
        val text = "<tool_call>\n<function=run_commands>\n<parameter=command>\nls -la\n</parameter>\n<parameter=count>\n3\n</parameter>\n</function>\n</tool_call>"
        val (clean, calls, _) = ToolCallParser.parseToolCalls(text, SCHEMA)
        assertEquals("", clean)
        assertEquals(listOf("run_commands" to args("command" to s("ls -la"), "count" to n(3))), namesArgs(calls))
    }

    @Test
    fun `qwen3 coder xml no wrapper`() {
        val text = "text <function=run_commands>\n<parameter=command>\npwd\n</parameter>\n</function>"
        val (clean, calls, _) = ToolCallParser.parseToolCalls(text, SCHEMA)
        assertEquals("text", clean)
        assertEquals(listOf("run_commands" to args("command" to s("pwd"))), namesArgs(calls))
    }

    @Test
    fun `glm format`() {
        val text = "<tool_call>list_files\n<arg_key>path</arg_key>\n<arg_value>src</arg_value>\n<arg_key>count</arg_key>\n<arg_value>2</arg_value></tool_call>"
        val sch = schema("list_files" to props("path" to "string", "count" to "integer"))
        val (_, calls, _) = ToolCallParser.parseToolCalls(text, sch)
        assertEquals(listOf("list_files" to args("path" to s("src"), "count" to n(2))), namesArgs(calls))
    }

    @Test
    fun `glm format name inline and missing value open tag`() {
        val text = ("Completed\n\n<tool_call>list_tree<arg_key>directoryPath</arg_key>.</arg_value>" +
            "<arg_key>maxDepth</arg_key><arg_value>2</arg_value>" +
            "<arg_key>projectPath</arg_key>/srv/x</arg_value></tool_call>" +
            "<tool_call>run_commands<arg_key>commands</arg_key><arg_value>[\"ls\", \"pwd\"]</arg_value></tool_call>")
        val sch = schema(
            "list_tree" to props("directoryPath" to "string", "maxDepth" to "integer", "projectPath" to "string"),
            "run_commands" to props("commands" to "array"),
        )
        val (clean, calls, _) = ToolCallParser.parseToolCalls(text, sch)
        assertEquals("Completed", clean)
        assertEquals(
            listOf(
                "list_tree" to args("directoryPath" to s("."), "maxDepth" to n(2), "projectPath" to s("/srv/x")),
                "run_commands" to args("commands" to kotlinx.serialization.json.JsonArray(listOf(s("ls"), s("pwd")))),
            ),
            namesArgs(calls),
        )
    }

    @Test
    fun `json flat args with unquoted value`() {
        val text = "<tool_call> {\"name\": \"exec_cmd\", \"command\": \"ls | tail -5\", \"executeInShell\": true, \"maxLinesCount\": 40, \"projectPath\": /srv/x, \"timeout\": 420000}"
        val sch = schema("exec_cmd" to props("command" to "string"))
        val (clean, calls, _) = ToolCallParser.parseToolCalls(text, sch)
        assertEquals("", clean)
        assertEquals(
            listOf("exec_cmd" to args(
                "command" to s("ls | tail -5"), "executeInShell" to b(true),
                "maxLinesCount" to n(40), "projectPath" to s("/srv/x"), "timeout" to n(420000))),
            namesArgs(calls),
        )
    }

    @Test
    fun `xml value with special chars`() {
        val text = "<tool_call>\n<function=run_commands>\n<parameter=command>\necho a < b\nsecond line\n</parameter>\n</function>\n</tool_call>"
        val (_, calls, _) = ToolCallParser.parseToolCalls(text, SCHEMA)
        assertEquals(listOf("run_commands" to args("command" to s("echo a < b\nsecond line"))), namesArgs(calls))
    }

    @Test
    fun `multiple calls`() {
        val text = "<tool_call>\n{\"name\": \"read_file\", \"arguments\": {\"path\": \"a\"}}\n</tool_call>\n<tool_call>\n{\"name\": \"list_files\", \"arguments\": {\"path\": \"b\"}}\n</tool_call>"
        val (_, calls, _) = ToolCallParser.parseToolCalls(text, SCHEMA)
        assertEquals(listOf("read_file", "list_files"), calls.map { it.name })
    }

    @Test
    fun `text before call preserved`() {
        val (clean, _, _) = ToolCallParser.parseToolCalls("Sure! <tool_call>\n{\"name\":\"read_file\",\"arguments\":{\"path\":\"x\"}}\n</tool_call>", SCHEMA)
        assertEquals("Sure!", clean)
    }

    @Test
    fun `think block excluded`() {
        val text = "<think>I will call <tool_call>{\"name\":\"run_commands\",\"arguments\":{\"command\":\"rm -rf /\"}}</tool_call></think><tool_call>\n{\"name\":\"list_files\",\"arguments\":{\"path\":\".\"}}\n</tool_call>"
        val (clean, calls, reasoning) = ToolCallParser.parseToolCalls(text, SCHEMA)
        assertEquals(listOf("list_files"), calls.map { it.name })
        assertTrue(reasoning!!.contains("rm -rf /"))
        assertEquals("", clean)
    }

    @Test
    fun `unclosed tool call`() {
        val text = "ok <tool_call>\n{\"name\": \"read_file\", \"arguments\": {\"path\": \"a.py\"}}\n"
        val (clean, calls, _) = ToolCallParser.parseToolCalls(text, SCHEMA)
        assertEquals("ok", clean)
        assertEquals(listOf("read_file" to args("path" to s("a.py"))), namesArgs(calls))
    }

    @Test
    fun `parameters alias`() {
        val text = "<tool_call>\n{\"name\": \"read_file\", \"parameters\": {\"path\": \"a\"}}\n</tool_call>"
        val (_, calls, _) = ToolCallParser.parseToolCalls(text, SCHEMA)
        assertEquals(listOf("read_file" to args("path" to s("a"))), namesArgs(calls))
    }

    @Test
    fun `arguments as string`() {
        val text = "<tool_call>\n{\"name\": \"read_file\", \"arguments\": \"{\\\"path\\\": \\\"a\\\"}\"}\n</tool_call>"
        val (_, calls, _) = ToolCallParser.parseToolCalls(text, SCHEMA)
        assertEquals(listOf("read_file" to args("path" to s("a"))), namesArgs(calls))
    }

    @Test
    fun `plain text untouched`() {
        val (clean, calls, _) = ToolCallParser.parseToolCalls("Just a reply, no tools.", SCHEMA)
        assertEquals("Just a reply, no tools.", clean)
        assertTrue(calls.isEmpty())
    }

    @Test
    fun `json fence inside tag`() {
        val text = "<tool_call>\n```json\n{\"name\": \"read_file\", \"arguments\": {\"path\": \"a\"}}\n```\n</tool_call>"
        val (_, calls, _) = ToolCallParser.parseToolCalls(text, SCHEMA)
        assertEquals(listOf("read_file" to args("path" to s("a"))), namesArgs(calls))
    }

    @Test
    fun `function key instead of name`() {
        val text = "<tool_call>\n{\"function\": \"read_file\", \"arguments\": {\"path\": \"a\"}}\n</tool_call>"
        val (clean, calls, _) = ToolCallParser.parseToolCalls(text, SCHEMA)
        assertEquals(1, calls.size)
        assertEquals("", clean)
        assertEquals("read_file", calls[0].name)
        assertEquals(args("path" to s("a")), calls[0].arguments)
    }

    @Test
    fun `function key nested dict`() {
        val text = "<tool_call>{\"type\": \"function\", \"function\": {\"name\": \"read_file\", \"arguments\": {\"path\": \"a\"}}}</tool_call>"
        val (_, calls, _) = ToolCallParser.parseToolCalls(text, SCHEMA)
        assertEquals("read_file", calls[0].name)
        assertEquals(args("path" to s("a")), calls[0].arguments)
    }

    @Test
    fun `function name key`() {
        val text = "<tool_call>\n{\"function_name\": \"read_file\", \"arguments\": {\"path\": \"a\"}}\n</tool_call>"
        val (_, calls, _) = ToolCallParser.parseToolCalls(text, SCHEMA)
        assertEquals(listOf("read_file" to args("path" to s("a"))), namesArgs(calls))
    }

    @Test
    fun `mangled functionname prefix`() {
        val text = "<tool_call> <functionname=\"run_commands\", \"arguments\": {\"commands\": [\"grep -rn \"a\\\\|b\" --include=\\\"*.py\\\" .\"]}} </tool_call>"
        val (clean, calls, _) = ToolCallParser.parseToolCalls(text, schema("run_commands" to JsonObject(emptyMap())))
        assertEquals("", clean)
        assertEquals(
            listOf("run_commands" to args("commands" to kotlinx.serialization.json.JsonArray(listOf(s("grep -rn \"a\\|b\" --include=\"*.py\" ."))))),
            namesArgs(calls),
        )
    }

    @Test
    fun `json unescaped inner quotes`() {
        val text = ("<tool_call> {\"name\": \"ask_question\", \"arguments\": {\"question\": \"Where is the key?\", " +
            "\"options\": [\"\"API Keys\" or \"Keys\" tab\", \"A \"Settings\" / \"Account\" area\", " +
            "\"write it as \"find your key\", I'll fix it\"]} </tool_call>")
        val (clean, calls, _) = ToolCallParser.parseToolCalls(text, schema("ask_question" to JsonObject(emptyMap())))
        assertEquals("", clean)
        assertEquals(
            listOf("ask_question" to args(
                "question" to s("Where is the key?"),
                "options" to kotlinx.serialization.json.JsonArray(listOf(
                    s("\"API Keys\" or \"Keys\" tab"), s("A \"Settings\" / \"Account\" area"),
                    s("write it as \"find your key\", I'll fix it"))),
            )),
            namesArgs(calls),
        )
    }

    @Test
    fun `call to unoffered tool is not emitted`() {
        val text = "Writing now.\n<tool_call>\n{\"name\": \"editor\", \"arguments\": {\"path\": \"a.py\"}}\n</tool_call>"
        val (clean, calls, _) = ToolCallParser.parseToolCalls(text, SCHEMA)
        assertTrue(calls.isEmpty())
        assertTrue(clean.contains("\"editor\""))
    }

    private val EXEC_SCHEMA = schema("RunTerminal" to props("command" to "string"))

    @Test
    fun `nested tool call uses innermost call`() {
        val call = "{\"name\": \"read_file\", \"arguments\": {\"path\": \"a.py\"}}"
        val text = "<tool_call>\n{\"function_results\">\n</function_results>\n\n<tool_call>\n$call\n</tool_call>"
        val (clean, calls, _) = ToolCallParser.parseToolCalls(text, SCHEMA)
        assertEquals("", clean)
        assertEquals(listOf("read_file" to args("path" to s("a.py"))), namesArgs(calls))
    }

    @Test
    fun `execute command translated to RunTerminal`() {
        val call = "{\"name\": \"execute_command\", \"arguments\": {\"command\": \"ls -la\"}}"
        val (_, calls, _) = ToolCallParser.parseToolCalls("<tool_call>\n$call\n</tool_call>", EXEC_SCHEMA)
        assertEquals(listOf("RunTerminal" to args("command" to s("ls -la"))), namesArgs(calls))
    }

    @Test
    fun `bash with multiple commands not translated`() {
        val call = "{\"name\": \"bash\", \"arguments\": {\"commands\": [\"a\", \"b\"]}}"
        val (clean, calls, _) = ToolCallParser.parseToolCalls("<tool_call>\n$call\n</tool_call>", EXEC_SCHEMA)
        assertTrue(calls.isEmpty())
        assertTrue(clean.contains("bash"))
    }

    @Test
    fun `run_commands alias translates single command`() {
        val call = "{\"name\": \"run_commands\", \"arguments\": {\"commands\": [\"ls\"]}}"
        val (_, calls, _) = ToolCallParser.parseToolCalls("<tool_call>\n$call\n</tool_call>", EXEC_SCHEMA)
        assertEquals(listOf("RunTerminal" to args("command" to s("ls"))), namesArgs(calls))
    }

    @Test
    fun `alias untouched when offered or no runterminal`() {
        val text = "<tool_call>\n{\"name\": \"run_commands\", \"arguments\": {\"command\": \"ls\"}}\n</tool_call>"
        val (_, calls, _) = ToolCallParser.parseToolCalls(text, SCHEMA)
        assertEquals(listOf("run_commands" to args("command" to s("ls"))), namesArgs(calls))
        val (_, calls2, _) = ToolCallParser.parseToolCalls(text, schema("read_file" to JsonObject(emptyMap())))
        assertTrue(calls2.isEmpty())
    }

    private val GLM_SCHEMA = schema("search_codebase" to props("queries" to "array", "n" to "integer"))

    @Test
    fun `glm key written as arg value closed by arg key`() {
        val text = "<tool_call>search_codebase</arg_key>\n<arg_value>queries</arg_key>\n<arg_value>[\"BoMM Sell\", \"Net GP\"]</arg_value></tool_call>"
        val (clean, calls, _) = ToolCallParser.parseToolCalls(text, GLM_SCHEMA)
        assertEquals("", clean)
        assertEquals(
            listOf("search_codebase" to args("queries" to kotlinx.serialization.json.JsonArray(listOf(s("BoMM Sell"), s("Net GP"))))),
            namesArgs(calls),
        )
    }

    @Test
    fun `glm mangled keys on multiple args`() {
        val text = "<tool_call>search_codebase</arg_key>\n<arg_value>queries</arg_key>\n<arg_value>[\"a\"]</arg_value>\n<arg_value>n</arg_key>\n<arg_value>3</arg_value></tool_call>"
        val (_, calls, _) = ToolCallParser.parseToolCalls(text, GLM_SCHEMA)
        assertEquals(
            listOf("search_codebase" to args("queries" to kotlinx.serialization.json.JsonArray(listOf(s("a"))), "n" to n(3))),
            namesArgs(calls),
        )
    }

    @Test
    fun `tool name glued before json args and unclosed`() {
        val text = "<tool_call>run_commands{\"commands\": [\"ls docs\"]}"
        val (clean, calls, _) = ToolCallParser.parseToolCalls(text, schema("run_commands" to props()))
        assertEquals("", clean)
        assertEquals(
            listOf("run_commands" to args("commands" to kotlinx.serialization.json.JsonArray(listOf(s("ls docs"))))),
            namesArgs(calls),
        )
    }

    @Test
    fun `tool name with double underscore before json args`() {
        val sch = schema("jetbrains-pycharm__list_directory_tree" to props())
        val text = "<tool_call>jetbrains-pycharm__list_directory_tree{\"directoryPath\": \"docs\", \"maxDepth\": 3}</tool_call>"
        val (_, calls, _) = ToolCallParser.parseToolCalls(text, sch)
        assertEquals(
            listOf("jetbrains-pycharm__list_directory_tree" to args("directoryPath" to s("docs"), "maxDepth" to n(3))),
            namesArgs(calls),
        )
    }

    @Test
    fun `unparseable block stays in text`() {
        val text = "<tool_call>not json at all</tool_call>"
        val (clean, calls, _) = ToolCallParser.parseToolCalls(text, SCHEMA)
        assertTrue(calls.isEmpty())
        assertEquals(text, clean)
    }

    @Test
    fun `json arguments null and list rejected`() {
        var text = "<tool_call>{\"name\": \"read_file\", \"arguments\": null}</tool_call>"
        var (clean, calls, _) = ToolCallParser.parseToolCalls(text, SCHEMA)
        assertTrue(calls.isEmpty())
        assertEquals(text, clean)
        text = "<tool_call>{\"name\": \"read_file\", \"arguments\": [1]}</tool_call>"
        val r = ToolCallParser.parseToolCalls(text, SCHEMA)
        assertTrue(r.calls.isEmpty())
        assertEquals(text, r.clean)
    }

    @Test
    fun `json arguments non object rejected`() {
        for (a in listOf("null", "[]", "42", "\"[1]\"")) {
            val text = "<tool_call>{\"name\": \"read_file\", \"arguments\": $a}</tool_call>"
            val (clean, calls, _) = ToolCallParser.parseToolCalls(text, SCHEMA)
            assertTrue(calls.isEmpty())
            assertEquals(text, clean)
        }
    }

    @Test
    fun `json arguments unterminated string rejected`() {
        val text = "<tool_call>{\"name\":\"read_file\",\"arguments\":\"{\\\"path\\\": \\\"unfinished\"}</tool_call>"
        val (clean, calls, _) = ToolCallParser.parseToolCalls(text, SCHEMA)
        assertTrue(calls.isEmpty())
        assertEquals(text, clean)
    }

    @Test
    fun `json arguments object forms accepted`() {
        var (_, calls, _) = ToolCallParser.parseToolCalls("<tool_call>{\"name\": \"read_file\", \"arguments\": {}}</tool_call>", SCHEMA)
        assertEquals(listOf("read_file" to args()), namesArgs(calls))
        val r = ToolCallParser.parseToolCalls("<tool_call>{\"name\": \"read_file\", \"arguments\": \"{\\\"path\\\": \\\"a\\\"}\"}</tool_call>", SCHEMA)
        assertEquals(listOf("read_file" to args("path" to s("a"))), namesArgs(r.calls))
    }

    @Test
    fun `json bare name and value repaired`() {
        val text = "<tool_call>{\"name\": read_file, \"arguments\": {\"path\": a.py}}</tool_call>"
        val (clean, calls, _) = ToolCallParser.parseToolCalls(text, SCHEMA)
        assertEquals("", clean)
        assertEquals(listOf("read_file" to args("path" to s("a.py"))), namesArgs(calls))
    }

    @Test
    fun `function block value keeps trailing newline`() {
        val text = "<function=run_commands>\n<parameter=command>\nline1\n\nline2\n\n</parameter>\n</function>"
        val (_, calls, _) = ToolCallParser.parseToolCalls(text, SCHEMA)
        assertEquals(listOf("run_commands" to args("command" to s("line1\n\nline2\n"))), namesArgs(calls))
    }

    @Test
    fun `function block missing closer`() {
        val text = "go <function=read_file>\n<parameter=path>\na\n</parameter>\n"
        val (clean, calls, _) = ToolCallParser.parseToolCalls(text, SCHEMA)
        assertEquals("go", clean)
        assertEquals(listOf("read_file" to args("path" to s("a"))), namesArgs(calls))
    }

    @Test
    fun `function block coercion leaves bad values`() {
        val sch = schema("t" to props("n" to "integer", "b" to "boolean", "f" to "boolean"))
        val text = "<function=t>\n<parameter=n>abc</parameter>\n<parameter=b>True</parameter>\n<parameter=f>x</parameter>\n</function>"
        val (_, calls, _) = ToolCallParser.parseToolCalls(text, sch)
        assertEquals(listOf("t" to args("n" to s("abc"), "b" to b(true), "f" to s("x"))), namesArgs(calls))
    }

    @Test
    fun `glm values trimmed and missing closer`() {
        val text = "<tool_call>list_files\n<arg_key>path</arg_key>\n<arg_value>\nsrc\n</arg_value>\n<arg_key>count</arg_key><arg_value>2\n<arg_key>flag</arg_key><arg_value>true</arg_value></tool_call>"
        val sch = schema("list_files" to props("path" to "string", "count" to "integer", "flag" to "boolean"))
        val (_, calls, _) = ToolCallParser.parseToolCalls(text, sch)
        assertEquals(
            listOf("list_files" to args("path" to s("src"), "count" to n(2), "flag" to b(true))),
            namesArgs(calls),
        )
    }

    @Test
    fun `unclosed think swallows following call`() {
        val text = "<think>plan <tool_call>{\"name\":\"read_file\",\"arguments\":{\"path\":\"a\"}}</tool_call>"
        val (clean, calls, reasoning) = ToolCallParser.parseToolCalls(text, SCHEMA)
        assertTrue(calls.isEmpty())
        assertEquals("", clean)
        assertTrue(reasoning!!.contains("plan"))
    }

    @Test
    fun `alias without usable command is dropped`() {
        var text = "<tool_call>{\"name\": \"bash\", \"arguments\": {\"script\": \"ls\"}}</tool_call>"
        var (clean, calls, _) = ToolCallParser.parseToolCalls(text, EXEC_SCHEMA)
        assertTrue(calls.isEmpty())
        assertTrue(clean.contains("\"bash\""))
        text = "<tool_call>{\"name\": \"bash\", \"arguments\": {\"commands\": [\"\", \"ls\"]}}</tool_call>"
        val r = ToolCallParser.parseToolCalls(text, EXEC_SCHEMA)
        assertTrue(r.calls.isEmpty())
    }

    @Test
    fun `failure code cases`() {
        val cases = listOf(
            "<tool_call>[1, 2]</tool_call>" to "TC-JSON-NO-OBJECT",
            "<tool_call>{\"arguments\": {\"path\": \"a\"}}</tool_call>" to "TC-NAME-MISSING",
            "<tool_call>{\"name\": \"read_file\", \"arguments\": {\"path\": \"a</tool_call>" to "TC-JSON-INVALID",
            "<tool_call><arg_key>path</arg_key><arg_value>a</arg_value></tool_call>" to "TC-GLM-NO-NAME",
            "<tool_call><function=read_file</tool_call>" to "TC-FUNC-NO-HEADER",
            "<tool_call>{\"name\": \"read_file\", \"arguments\": null}</tool_call>" to "TC-ARGS-INVALID",
        )
        for ((text, _) in cases) {
            val (clean, calls, _) = ToolCallParser.parseToolCalls(text, SCHEMA)
            assertTrue(calls.isEmpty())
            assertEquals(text, clean)
        }
    }

    @Test
    fun `multiple syntaxes in one reply`() {
        val text = ("start <tool_call>{\"name\":\"read_file\",\"arguments\":{\"path\":\"a\"}}</tool_call> mid " +
            "<function=list_files>\n<parameter=path>\nb\n</parameter>\n</function> end " +
            "<tool_call>read_file<arg_key>path</arg_key><arg_value>b</arg_value></tool_call> tail")
        val (clean, calls, _) = ToolCallParser.parseToolCalls(text, SCHEMA)
        assertEquals(
            listOf(
                "read_file" to args("path" to s("a")),
                "list_files" to args("path" to s("b")),
                "read_file" to args("path" to s("b")),
            ),
            namesArgs(calls),
        )
        assertTrue(!clean.contains("<tool_call>") && !clean.contains("<function="))
        assertTrue(clean.contains("start") && clean.contains("mid") && clean.contains("end") && clean.contains("tail"))
    }

    private val GLUED_NAME = "jetbrains-pycharm__list_directory_tree{\"directoryPath\": \"docs/features\", \"maxDepth\": 1, \"projectPath\": \"/srv/compose/bulkonline\"}<tool_call>jetbrains-pycharm__search_in_files_by_regex{\"maxUsageCount\": 50, \"projectPath\": \"/srv/compose/bulkonline\", \"regexPattern\": \"reset_password|password_reset|signup_token|reset_token\"}<tool_call>jetbrains-pycharm__find_files_by_name_keyword{\"nameKeyword\": \"Password\", \"projectPath\": \"/srv/compose/bulkonline\"}"

    private val JETBRAINS_SCHEMA = schema(
        "jetbrains-pycharm__list_directory_tree" to props("maxDepth" to "integer"),
        "jetbrains-pycharm__search_in_files_by_regex" to props(),
        "jetbrains-pycharm__find_files_by_name_keyword" to props(),
    )

    private fun native(name: String, arguments: String = "{}") = RawToolCall("chatcmpl-tool-a3931ad07b53e4fc", name, arguments)

    @Test
    fun `native call with several calls glued into name`() {
        val calls = ToolCallParser.repairNativeCall(native(GLUED_NAME), JETBRAINS_SCHEMA)
        assertEquals(
            listOf(
                "jetbrains-pycharm__list_directory_tree",
                "jetbrains-pycharm__search_in_files_by_regex",
                "jetbrains-pycharm__find_files_by_name_keyword",
            ),
            calls.map { it.name },
        )
        assertEquals(s("docs/features"), calls[0].arguments["directoryPath"])
        assertEquals(n(1), calls[0].arguments["maxDepth"])
        assertEquals(3, calls.map { it.id }.toSet().size)
    }

    @Test
    fun `native call left alone when name is valid`() {
        val calls = ToolCallParser.repairNativeCall(native("jetbrains-pycharm__list_directory_tree", "{\"maxDepth\": 1}"), JETBRAINS_SCHEMA)
        assertEquals(1, calls.size)
        assertEquals("jetbrains-pycharm__list_directory_tree", calls[0].name)
        assertEquals(args("maxDepth" to n(1)), calls[0].arguments)
    }

    @Test
    fun `native call rejected when piece names unoffered tool`() {
        val sch = JETBRAINS_SCHEMA - "jetbrains-pycharm__find_files_by_name_keyword"
        val e = assertThrows(ToolCallParseException::class.java) {
            ToolCallParser.repairNativeCall(native(GLUED_NAME), sch)
        }
        assertEquals("TC-NATIVE-INVALID", e.code)
    }

    @Test
    fun `native call rejected when piece has unterminated string`() {
        val e = assertThrows(ToolCallParseException::class.java) {
            ToolCallParser.repairNativeCall(native("jetbrains-pycharm__list_directory_tree{\"directoryPath\": \"docs/feat"), JETBRAINS_SCHEMA)
        }
        assertEquals("TC-NATIVE-INVALID", e.code)
    }

    @Test
    fun `native call with alias name and separate arguments`() {
        val calls = ToolCallParser.repairNativeCall(native("bash", "{\"commands\": [\"ls -la\"]}"), EXEC_SCHEMA)
        assertEquals(listOf("RunTerminal" to args("command" to s("ls -la"))), namesArgs(calls))
    }

    @Test
    fun `native call with glm arg tags in name`() {
        val calls = ToolCallParser.repairNativeCall(native("list_files<arg_key>path</arg_key><arg_value>src</arg_value>"), SCHEMA)
        assertEquals(listOf("list_files" to args("path" to s("src"))), namesArgs(calls))
    }

    @Test
    fun `native call unknown name rejected`() {
        val e = assertThrows(ToolCallParseException::class.java) {
            ToolCallParser.repairNativeCall(native("mystery", "{\"x\": 1}"), SCHEMA)
        }
        assertEquals("TC-NATIVE-INVALID", e.code)
    }

    @Test
    fun `native call valid name unterminated args rejected`() {
        val e = assertThrows(ToolCallParseException::class.java) {
            ToolCallParser.repairNativeCall(native("read_file", "{\"path\": \"unfinished"), SCHEMA)
        }
        assertEquals("TC-ARGS-INVALID", e.code)
    }

    @Test
    fun `native call valid name non object args rejected`() {
        val e = assertThrows(ToolCallParseException::class.java) {
            ToolCallParser.repairNativeCall(native("read_file", "[1]"), SCHEMA)
        }
        assertEquals("TC-ARGS-INVALID", e.code)
    }

    @Test
    fun `qwen json name key written with function tag syntax`() {
        val text = "\n\n<tool_call>\n{\"function_name=\"run_commands>\", \"arguments\": {\"commands\": [\"ls -la docs/features/\", \"echo '===RESET FILES==='\", \"grep -rl 'reset_password\\\\|resettoken\\\\|password_reset\\\\|reset_token' addons/ --include=*.py | head -40\"]}}\n</tool_call>"
        val (clean, calls, _) = ToolCallParser.parseToolCalls(text, schema("run_commands" to JsonObject(emptyMap())))
        assertEquals("", clean)
        assertEquals(
            listOf("run_commands" to args("commands" to kotlinx.serialization.json.JsonArray(listOf(
                s("ls -la docs/features/"), s("echo '===RESET FILES==='"),
                s("grep -rl 'reset_password\\|resettoken\\|password_reset\\|reset_token' addons/ --include=*.py | head -40"))))),
            namesArgs(calls),
        )
    }

    private val CALL_TAG_SCHEMA = schema(
        "jetbrains-pycharm__list_directory_tree" to props("directoryPath" to "string", "maxDepth" to "integer", "projectPath" to "string"),
        "jetbrains-pycharm__find_files_by_name_keyword" to props("nameKeyword" to "string", "fileCountLimit" to "integer", "projectPath" to "string"),
        "read_files" to props("files" to "array"),
        "run_commands" to props("commands" to "array"),
    )

    @Test
    fun `glm call tag two calls`() {
        val text = ("<call>\n{\"name\": \"jetbrains-pycharm__list_directory_tree\", \"arguments\": {\"directoryPath\": \"addons/boxer_password_policy\", \"maxDepth\": 4, \"projectPath\": \"/srv/compose/bulkonline\"}}\n</call>\n" +
            "<call>\n{\"name\": \"jetbrains-pycharm__find_files_by_name_keyword\", \"arguments\": {\"nameKeyword\": \"main.py\", \"fileCountLimit\": 20, \"projectPath\": \"/srv/compose/bulkonline\"}}\n</call>")
        val (clean, calls, _) = ToolCallParser.parseToolCalls(text, CALL_TAG_SCHEMA)
        assertEquals("", clean)
        assertEquals(
            listOf(
                "jetbrains-pycharm__list_directory_tree" to args("directoryPath" to s("addons/boxer_password_policy"), "maxDepth" to n(4), "projectPath" to s("/srv/compose/bulkonline")),
                "jetbrains-pycharm__find_files_by_name_keyword" to args("nameKeyword" to s("main.py"), "fileCountLimit" to n(20), "projectPath" to s("/srv/compose/bulkonline")),
            ),
            namesArgs(calls),
        )
    }

    @Test
    fun `glm call tag missing closing brace repaired`() {
        val text = ("<call>\n{\"name\": \"read_files\", \"arguments\": {\"files\": [{\"path\": \"/srv/compose/bulkonline/addons/boxer_password_policy/__manifest__.py\"}, {\"path\": \"/srv/compose/bulkonline/addons/boxer_password_policy/models/res_users.py\"}]}\n</call>\n" +
            "<call>\n{\"name\": \"run_commands\", \"arguments\": {\"commands\": [\"ls /srv/volumes/odoo_common/ | grep -i odoo19 | tail -5\"]}}\n</call>")
        val (clean, calls, _) = ToolCallParser.parseToolCalls(text, CALL_TAG_SCHEMA)
        assertEquals("", clean)
        assertEquals(
            listOf(
                "read_files" to args("files" to kotlinx.serialization.json.JsonArray(listOf(
                    args("path" to s("/srv/compose/bulkonline/addons/boxer_password_policy/__manifest__.py")),
                    args("path" to s("/srv/compose/bulkonline/addons/boxer_password_policy/models/res_users.py"))))),
                "run_commands" to args("commands" to kotlinx.serialization.json.JsonArray(listOf(
                    s("ls /srv/volumes/odoo_common/ | grep -i odoo19 | tail -5")))),
            ),
            namesArgs(calls),
        )
    }

    @Test
    fun `call tag with unterminated string is not run`() {
        val text = "<call>\n{\"name\": \"run_commands\", \"arguments\": {\"commands\": [\"rm -rf /srv/compose/bulkonline/te"
        val (clean, calls, _) = ToolCallParser.parseToolCalls(text, CALL_TAG_SCHEMA)
        assertTrue(calls.isEmpty())
        assertEquals(text, clean)
    }

    @Test
    fun `quoted example in fence stays text`() {
        val text = "Example:\n```\n<tool_call>{\"name\":\"read_file\",\"arguments\":{\"path\":\"a\"}}</tool_call>\n```\n<tool_call>{\"name\":\"read_file\",\"arguments\":{\"path\":\"b\"}}</tool_call>"
        val (clean, calls, _) = ToolCallParser.parseToolCalls(text, SCHEMA)
        assertEquals(listOf("read_file" to args("path" to s("b"))), namesArgs(calls))
        assertTrue(clean.contains("\"path\":\"a\""))
    }

    @Test
    fun `quoted example with backtick stays text`() {
        val text = "Use `<tool_call>{\"name\":\"read_file\",\"arguments\":{\"path\":\"a\"}}</tool_call>` like this"
        val (clean, calls, _) = ToolCallParser.parseToolCalls(text, SCHEMA)
        assertTrue(calls.isEmpty())
        assertTrue(clean.contains("read_file"))
    }

    @Test
    fun `start in fence keeps tag as text`() {
        val r = ToolCallParser.parseToolCalls(
            "<tool_call>{\"name\":\"read_file\",\"arguments\":{\"path\":\"a\"}}</tool_call>",
            SCHEMA, startInFence = true)
        assertTrue(r.calls.isEmpty())
    }

    @Test
    fun `coerce number and object types`() {
        val sch = schema("t" to props("n" to "number", "o" to "object", "a" to "array"))
        val text = "<function=t>\n<parameter=n>1.5</parameter>\n<parameter=o>{\"x\":1}</parameter>\n<parameter=a>[1]</parameter>\n</function>"
        val (_, calls, _) = ToolCallParser.parseToolCalls(text, sch)
        assertEquals(JsonPrimitive(1.5), calls[0].arguments["n"])
        assertEquals(args("x" to n(1)), calls[0].arguments["o"])
        assertEquals(kotlinx.serialization.json.JsonArray(listOf(n(1))), calls[0].arguments["a"])
    }

    @Test
    fun `call tag unclosed block parses`() {
        val text = "go <call>\n{\"name\": \"read_file\", \"arguments\": {\"path\": \"a\"}}"
        val (clean, calls, _) = ToolCallParser.parseToolCalls(text, SCHEMA)
        assertEquals("go", clean)
        assertEquals("read_file", calls[0].name)
    }

    @Test
    fun `tool call without nested opener`() {
        val text = "<tool_call>x</tool_call><tool_call>{\"name\":\"read_file\",\"arguments\":{}}</tool_call>"
        val (clean, calls, _) = ToolCallParser.parseToolCalls(text, SCHEMA)
        assertEquals(1, calls.size)
        assertTrue(clean.contains("x"))
    }

    @Test
    fun `alias with non string command element dropped`() {
        val text = "<tool_call>{\"name\": \"bash\", \"arguments\": {\"commands\": [1]}}</tool_call>"
        val (_, calls, _) = ToolCallParser.parseToolCalls(text, EXEC_SCHEMA)
        assertTrue(calls.isEmpty())
    }

    @Test
    fun `arguments string containing number rejected`() {
        val text = "<tool_call>{\"name\": \"read_file\", \"arguments\": \"5\"}</tool_call>"
        val (_, calls, _) = ToolCallParser.parseToolCalls(text, SCHEMA)
        assertTrue(calls.isEmpty())
    }

    @Test
    fun `boolean bare literal untouched`() {
        val text = "<tool_call>{\"name\": \"read_file\", \"arguments\": {\"path\": true}}</tool_call>"
        val (_, calls, _) = ToolCallParser.parseToolCalls(text, SCHEMA)
        assertEquals(listOf("read_file" to args("path" to b(true))), namesArgs(calls))
    }
}
