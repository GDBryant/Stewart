package com.aijb.assistant

import com.aijb.assistant.provider.ToolCall
import com.aijb.assistant.provider.ToolSpec
import com.aijb.assistant.tools.Tool
import com.aijb.assistant.tools.ToolRegistry
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ToolRegistryTest {

    private fun reg(schema: JsonObject) = ToolRegistry(listOf(object : Tool {
        override val spec = ToolSpec("t", "d", schema)
        override val requiresApproval = false
        override suspend fun execute(arguments: JsonObject) = "x"
    }))

    private fun schema(props: Map<String, JsonObject>, required: List<String> = emptyList(), closed: Boolean = false) =
        JsonObject(mapOf(
            "type" to JsonPrimitive("object"),
            "properties" to JsonObject(props),
        ) + (if (required.isNotEmpty()) mapOf("required" to JsonArray(required.map { JsonPrimitive(it) })) else emptyMap()) +
            (if (closed) mapOf("additionalProperties" to JsonPrimitive(false)) else emptyMap()))

    private fun call(args: Map<String, kotlinx.serialization.json.JsonElement>) =
        ToolCall("c", "t", JsonObject(args))

    private fun s(v: String) = JsonPrimitive(v)
    private fun o(props: Map<String, JsonPrimitive>) = JsonObject(props)

    @Test
    fun `type arms`() {
        val sch = schema(mapOf(
            "str" to JsonObject(mapOf("type" to JsonPrimitive("string"))),
            "int" to JsonObject(mapOf("type" to JsonPrimitive("integer"))),
            "num" to JsonObject(mapOf("type" to JsonPrimitive("number"))),
            "bool" to JsonObject(mapOf("type" to JsonPrimitive("boolean"))),
            "arr" to JsonObject(mapOf("type" to JsonPrimitive("array"))),
            "obj" to JsonObject(mapOf("type" to JsonPrimitive("object"))),
            "multi" to JsonObject(mapOf("type" to JsonArray(listOf(JsonPrimitive("string"), JsonPrimitive("integer"))))),
            "any" to JsonObject(mapOf("type" to JsonPrimitive("weird"))),
            "none" to JsonObject(emptyMap()),
        ))
        val r = reg(sch)
        assertNull(r.validate(call(mapOf(
            "str" to s("x"), "int" to JsonPrimitive(1), "num" to JsonPrimitive(1.5),
            "bool" to JsonPrimitive(true), "arr" to JsonArray(emptyList()), "obj" to JsonObject(emptyMap()),
            "multi" to JsonPrimitive(2), "any" to JsonPrimitive(0), "none" to s("q")))))
        assertTrue(r.validate(call(mapOf("str" to JsonPrimitive(1)))) != null)
        assertTrue(r.validate(call(mapOf("int" to s("1x")))) != null)
        assertTrue(r.validate(call(mapOf("num" to s("x")))) != null)
        assertTrue(r.validate(call(mapOf("bool" to s("x")))) != null)
        assertTrue(r.validate(call(mapOf("arr" to s("x")))) != null)
        assertTrue(r.validate(call(mapOf("obj" to s("x")))) != null)
        assertTrue(r.validate(call(mapOf("multi" to JsonArray(emptyList())))) != null)
    }

    @Test
    fun `enum pass and fail`() {
        val r = reg(schema(mapOf("mode" to JsonObject(mapOf(
            "enum" to JsonArray(listOf(JsonPrimitive("a"), JsonPrimitive("b"))))))))
        assertNull(r.validate(call(mapOf("mode" to s("a")))))
        assertTrue(r.validate(call(mapOf("mode" to s("z"))))!!.contains("enum"))
    }

    @Test
    fun `unknown tool and missing required`() {
        val r = reg(schema(emptyMap(), required = listOf("path")))
        assertTrue(r.validate(ToolCall("c", "other", JsonObject(emptyMap())))!!.contains("unknown tool"))
        assertTrue(r.validate(call(emptyMap()))!!.contains("path"))
    }

    @Test
    fun `specs and find`() {
        val r = reg(schema(emptyMap()))
        assertEquals(listOf("t"), r.specs.map { it.name })
        assertNull(r.find("missing"))
        assertEquals("t", r.find("t")!!.spec.name)
    }
}
