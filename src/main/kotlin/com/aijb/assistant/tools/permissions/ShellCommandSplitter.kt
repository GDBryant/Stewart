package com.aijb.assistant.tools.permissions

import com.intellij.openapi.util.SystemInfo

/**
 * Splits a shell command line into the program tokens each sub-command launches. A grant can only
 * ever cover a [Parsed] result whose every program is granted; anything suspicious is
 * [Unparseable] and the caller must prompt. Pure function, no I/O.
 */
object ShellCommandSplitter {

    sealed interface Result
    data class Parsed(val programs: List<String>) : Result
    data class Unparseable(val reason: String) : Result

    fun split(command: String, windows: Boolean = SystemInfo.isWindows): Result =
        if (windows) splitWindows(command) else splitPosix(command)

    fun programsOrNull(command: String, windows: Boolean = SystemInfo.isWindows): List<String>? =
        (split(command, windows) as? Parsed)?.programs

    private val SHELLS = setOf("sh", "bash", "dash", "zsh", "ksh", "fish", "busybox")
    private val WINDOWS_BUILTINS = setOf("cmd", "call", "start", "set", "setx", "for", "if", "goto")
    private val LAUNCHERS = setOf(
        "xargs", "sudo", "doas", "su", "runuser", "env", "command", "builtin", "exec", "eval",
        "time", "timeout", "nice", "nohup", "stdbuf", "setsid", "chroot", "watch", "script",
        "source", ".", "awk", "sed", "call", "start",
    )
    private val INTERPRETERS = setOf(
        "perl", "ruby", "node", "deno", "bun", "php", "lua", "rscript", "pwsh", "powershell",
        "osascript",
    )
    private val SHELL_STATE = setOf(
        "export", "unset", "set", "setx", "alias", "unalias", "typeset", "declare", "readonly",
        "hash", "ulimit", "trap", "cd", "pushd", "popd", "for", "if", "while", "until", "case",
        "goto",
    )
    private val DANGEROUS_VARS = setOf(
        "PATH", "LD_PRELOAD", "LD_LIBRARY_PATH", "DYLD_INSERT_LIBRARIES", "IFS", "BASH_ENV", "ENV",
        "CDPATH", "SHELLOPTS", "GLOBIGNORE", "PYTHONPATH", "PYTHONSTARTUP", "NODE_OPTIONS",
        "PERL5OPT", "RUBYOPT", "SHELLOPTS",
    )
    private val FIND_EXEC_ARGS = setOf("-exec", "-execdir", "-ok", "-okdir", "-delete")

    private fun dangerous(name: String): Boolean {
        val base = name.substringAfterLast('/').substringAfterLast('\\').lowercase()
            .removeSuffix(".exe")
        return base in SHELLS || base in LAUNCHERS || base in INTERPRETERS || base in SHELL_STATE ||
            base.startsWith("python") || base.startsWith("pypy")
    }

    private class Scanner(private val s: String) {
        var i = 0
        var state = ' ' // ' ', '\'', '"'
        fun has() = i < s.length
        fun peek(o: Int = 0) = s.getOrNull(i + o)
        fun next() = s[i]
    }

    private fun splitPosix(command: String): Result {
        if (command.isBlank()) return Unparseable("empty command")
        val segments = mutableListOf<String>()
        val cur = StringBuilder()
        val sc = Scanner(command)
        while (sc.has()) {
            val c = sc.next()
            when (sc.state) {
                '\'' -> {
                    if (c == '\'') sc.state = ' '
                    cur.append(c)
                }
                '"' -> when {
                    c == '"' -> { sc.state = ' '; cur.append(c) }
                    c == '\\' -> {
                        val n = sc.peek(1) ?: return Unparseable("trailing escape")
                        cur.append(c).append(n); sc.i++
                    }
                    c == '`' -> return Unparseable("command substitution")
                    c == '$' && sc.peek(1) == '(' -> return Unparseable("command substitution")
                    else -> cur.append(c)
                }
                else -> when {
                    c == '\'' -> { sc.state = '\''; cur.append(c) }
                    c == '"' -> { sc.state = '"'; cur.append(c) }
                    c == '\\' -> {
                        val n = sc.peek(1) ?: return Unparseable("line continuation")
                        cur.append(c).append(n); sc.i++
                    }
                    c == '`' -> return Unparseable("command substitution")
                    c == '$' && (sc.peek(1) == '(' || sc.peek(1) == '\'') ->
                        return Unparseable("command substitution")
                    (c == '<' || c == '>') && sc.peek(1) == '(' ->
                        return Unparseable("process substitution")
                    c == '#' && (cur.isEmpty() || cur.last().isWhitespace()) -> {
                        while (sc.has() && sc.next() != '\n') sc.i++
                        continue
                    }
                    c == ';' || c == '\n' -> { segments += cur.toString(); cur.clear() }
                    c == '&' -> {
                        val prev = if (sc.i > 0) command[sc.i - 1] else ' '
                        val next = sc.peek(1)
                        when {
                            prev == '>' || next == '>' || prev == '|' -> cur.append(c)
                            else -> { segments += cur.toString(); cur.clear(); if (next == '&') sc.i++ }
                        }
                    }
                    c == '|' -> {
                        segments += cur.toString(); cur.clear()
                        if (sc.peek(1) == '|' || sc.peek(1) == '&') sc.i++
                    }
                    else -> cur.append(c)
                }
            }
            sc.i++
        }
        if (sc.state != ' ') return Unparseable("unbalanced quote")
        segments += cur.toString()

        val programs = mutableListOf<String>()
        for (segment in segments) {
            val tokens = tokenizePosix(segment)
            if (tokens.isEmpty()) continue
            val first = tokens.first()
            val fc = first.firstOrNull { it != ' ' }
            if (fc == '(' || fc == '{' || fc == '!') return Unparseable("grouping or negation")
            val checked = checkRedirections(tokens) ?: return Unparseable("file redirection")
            val it = checked.iterator()
            var program: String? = null
            for (t in it) {
                val assign = Regex("([A-Za-z_][A-Za-z0-9_]*)=(.*)").matchEntire(t)
                if (program == null && assign != null) {
                    if (assign.groupValues[1] in DANGEROUS_VARS) {
                        return Unparseable("dangerous assignment ${assign.groupValues[1]}")
                    }
                    continue
                }
                program = t
                break
            }
            if (program == null) {
                if (checked.isNotEmpty()) return Unparseable("assignments only")
                continue
            }
            val unquoted = unquote(program)
            if (dangerous(unquoted)) return Unparseable("unsafe program $unquoted")
            if (unquoted.substringAfterLast('/').equals("find", true) &&
                checked.any { it in FIND_EXEC_ARGS }
            ) {
                return Unparseable("find with exec")
            }
            programs += unquoted
        }
        if (programs.isEmpty()) return Unparseable("empty command")
        return Parsed(programs)
    }

    private fun tokenizePosix(segment: String): List<String> {
        val tokens = mutableListOf<String>()
        val cur = StringBuilder()
        var state = ' '
        var i = 0
        while (i < segment.length) {
            val c = segment[i]
            when (state) {
                '\'' -> { if (c == '\'') state = ' '; cur.append(c) }
                '"' -> {
                    when {
                        c == '"' -> { state = ' '; cur.append(c) }
                        c == '\\' && i + 1 < segment.length -> { cur.append(c).append(segment[i + 1]); i++ }
                        else -> cur.append(c)
                    }
                }
                else -> when {
                    c == '\'' -> { state = '\''; cur.append(c) }
                    c == '"' -> { state = '"'; cur.append(c) }
                    c == '\\' && i + 1 < segment.length -> { cur.append(c).append(segment[i + 1]); i++ }
                    c.isWhitespace() -> { if (cur.isNotEmpty()) { tokens += cur.toString(); cur.clear() } }
                    else -> cur.append(c)
                }
            }
            i++
        }
        if (cur.isNotEmpty()) tokens += cur.toString()
        return tokens
    }

    /**
     * Validates unquoted `<`/`>` uses (fd duplication `2>&1` and `/dev/null` only) and returns the
     * tokens with the redirection operators and targets removed; null when a file redirection or
     * heredoc exists.
     */
    private fun checkRedirections(tokens: List<String>): List<String>? {
        val kept = mutableListOf<String>()
        val it = tokens.listIterator()
        while (it.hasNext()) {
            val token = it.next()
            val pos = unquotedRedirectIndex(token) ?: run { kept += token; continue }
            if (pos > 0 && token[pos - 1] == '&') return null // &>, &>>
            val op = token[pos]
            var end = pos + 1
            if (op == '<' && end < token.length && token[end] == '<') return null // heredoc
            if (op == '>' && end < token.length && token[end] == '>') end++
            if (end < token.length && token[end] == '|') return null // >|
            val prefix = token.substring(0, pos)
            if (prefix.isNotEmpty() && !prefix.all(Char::isDigit)) kept += prefix
            var target = token.substring(end)
            if (target.isEmpty()) target = if (it.hasNext()) it.next() else return null
            if (target != "/dev/null" && !target.matches(Regex("&[0-9-]+"))) return null
        }
        return kept
    }

    private fun unquotedRedirectIndex(token: String): Int? {
        var state = ' '
        var i = 0
        while (i < token.length) {
            val c = token[i]
            when (state) {
                '\'' -> if (c == '\'') state = ' '
                '"' -> when {
                    c == '"' -> state = ' '
                    c == '\\' -> i++
                }
                else -> when {
                    c == '\'' -> state = '\''
                    c == '"' -> state = '"'
                    c == '\\' -> i++
                    c == '<' || c == '>' -> return i
                }
            }
            i++
        }
        return null
    }

    private fun unquote(token: String): String {
        if (token.length >= 2) {
            val a = token.first(); val b = token.last()
            if ((a == '\'' && b == '\'') || (a == '"' && b == '"')) {
                return token.substring(1, token.length - 1)
            }
        }
        return token
    }

    private fun splitWindows(command: String): Result {
        if (command.isBlank()) return Unparseable("empty command")
        var inQ = false
        for (c in command) {
            if (c == '"') inQ = !inQ
            else if (!inQ && (c == '^' || c == '%' || c == '(' || c == ')')) {
                return Unparseable("cmd expansion or grouping")
            }
        }
        if (inQ) return Unparseable("unbalanced quote")
        val segments = command.split(Regex("&&|\\|\\||&|\\|"))
        val programs = mutableListOf<String>()
        for (segment in segments) {
            val tokens = segment.trim().split(Regex("\\s+")).filter { it.isNotEmpty() }
            if (tokens.isEmpty()) continue
            val raw = tokens.first().trim('"')
            val normalized = raw.substringAfterLast('\\').lowercase().removeSuffix(".exe")
            if (normalized in WINDOWS_BUILTINS || dangerous(raw)) {
                return Unparseable("unsafe program $normalized")
            }
            programs += normalized
        }
        if (programs.isEmpty()) return Unparseable("empty command")
        return Parsed(programs)
    }
}
