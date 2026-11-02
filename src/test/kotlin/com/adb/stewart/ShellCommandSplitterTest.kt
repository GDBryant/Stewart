package com.adb.stewart

import com.adb.stewart.tools.permissions.ShellCommandSplitter
import com.adb.stewart.tools.permissions.ShellCommandSplitter.Parsed
import com.adb.stewart.tools.permissions.ShellCommandSplitter.Unparseable
import junit.framework.TestCase

class ShellCommandSplitterTest : TestCase() {

    private fun parse(command: String): List<String> =
        (ShellCommandSplitter.split(command, windows = false) as Parsed).programs

    private fun assertUnparseable(command: String, windows: Boolean = false) {
        val r = ShellCommandSplitter.split(command, windows)
        assertTrue("$command should be unparseable, got $r", r is Unparseable)
    }

    fun `test single program`() {
        assertEquals(listOf("git"), parse("git status"))
    }

    fun `test split on every separator`() {
        assertEquals(listOf("a", "b", "c", "d", "e", "f"), parse("a; b && c || d | e & f"))
        assertEquals(listOf("a", "b"), parse("a\nb"))
    }

    fun `test separators inside quotes are literal`() {
        assertEquals(listOf("echo"), parse("echo 'a;b' \"c|d\""))
        assertEquals(listOf("echo"), parse("echo 'a && b'"))
    }

    fun `test fd redirection is not a separator`() {
        assertEquals(listOf("cmd"), parse("cmd 2>&1"))
        assertEquals(listOf("cmd"), parse("cmd >&2"))
        assertEquals(listOf("cmd", "other"), parse("cmd 2>&1 | other"))
    }

    fun `test dev null redirection stays parseable`() {
        assertEquals(listOf("cmd"), parse("cmd > /dev/null"))
        assertEquals(listOf("cmd"), parse("cmd 2>/dev/null"))
        assertEquals(listOf("cmd"), parse("cmd < /dev/null"))
    }

    fun `test pipe stderr splits like a pipe`() {
        assertEquals(listOf("cmd", "grep"), parse("cmd |& grep"))
    }

    fun `test file redirection is unparseable`() {
        assertUnparseable("cmd > out.txt")
        assertUnparseable("cmd >> out.txt")
        assertUnparseable("cmd < in.txt")
        assertUnparseable("cmd &> out.txt")
        assertUnparseable("cmd >& out.txt")
        assertUnparseable("cmd <<EOF")
    }

    fun `test substitutions are unparseable`() {
        assertUnparseable("echo $(whoami)")
        assertUnparseable("echo `whoami`")
        assertUnparseable("echo \"$(whoami)\"")
        assertUnparseable("cat <(ls)")
        assertUnparseable("cat >(grep x)")
        assertUnparseable("echo $'\\n'")
    }

    fun `test substitutions inside single quotes are literal`() {
        assertEquals(listOf("echo"), parse("echo '$(whoami)' '`id`'"))
    }

    fun `test unbalanced quote and line continuation are unparseable`() {
        assertUnparseable("echo 'abc")
        assertUnparseable("echo \"abc")
        assertUnparseable("cmd \\")
    }

    fun `test leading assignments are stripped`() {
        assertEquals(listOf("git"), parse("FOO=1 BAR=2 git status"))
    }

    fun `test dangerous assignments are unparseable`() {
        assertUnparseable("PATH=/tmp git status")
        assertUnparseable("LD_PRELOAD=x.so git status")
        assertUnparseable("IFS=, cmd")
        assertUnparseable("BASH_ENV=x cmd")
        assertUnparseable("NODE_OPTIONS=--inspect node_ok")
    }

    fun `test assignments only is unparseable`() {
        assertUnparseable("FOO=1 BAR=2")
    }

    fun `test empty and comment only commands are unparseable`() {
        assertUnparseable("")
        assertUnparseable("   ")
        assertUnparseable("# just a comment")
        assertUnparseable("  # comment")
        assertEquals(listOf("echo"), parse("echo hi # trailing"))
    }

    fun `test grouping and negation are unparseable`() {
        assertUnparseable("(cd /tmp; rm -rf x)")
        assertUnparseable("{ rm -rf x; }")
        assertUnparseable("! rm x")
    }

    fun `test shells are unparseable`() {
        for (s in listOf("sh -c id", "bash -lc id", "sh -ec id", "/bin/sh -c id", "zsh -c id", "busybox sh -c id")) {
            assertUnparseable(s)
        }
    }

    fun `test interpreters are unparseable`() {
        for (s in listOf("python -c x", "python3 -c x", "pypy -c x", "perl -e x", "ruby -e x", "node -e x", "deno run x", "php -r x")) {
            assertUnparseable(s)
        }
    }

    fun `test launchers are unparseable`() {
        for (s in listOf("sudo ls", "xargs rm", "env ls", "exec ls", "eval ls", "timeout 1 ls", "nice ls", "nohup ls", "time ls", "command ls", ". foo.sh", "source foo.sh", "awk '{print}'", "sed s/a/b/")) {
            assertUnparseable(s)
        }
    }

    fun `test shell state builtins are unparseable`() {
        for (s in listOf("cd /tmp", "export A=1", "unset A", "alias x=y", "trap x", "ulimit -n 1", "set -e")) {
            assertUnparseable(s)
        }
    }

    fun `test find with exec is unparseable`() {
        assertUnparseable("find . -exec rm {} +")
        assertUnparseable("find . -execdir rm {} +")
        assertUnparseable("find . -delete")
        assertUnparseable("find . -ok rm {} +")
        assertEquals(listOf("find"), parse("find . -name '*.kt'"))
    }

    fun `test quoted program is unquoted`() {
        assertEquals(listOf("git"), parse("'git' status"))
        assertEquals(listOf("git"), parse("\"git\" status"))
    }

    fun `test program path kept verbatim`() {
        assertEquals(listOf("./gradlew"), parse("./gradlew test"))
        assertEquals(listOf("/usr/bin/git"), parse("/usr/bin/git status"))
    }

    fun `test windows splits and normalizes`() {
        val r = ShellCommandSplitter.split("GIT.EXE status & grep x", windows = true)
        assertEquals(listOf("git", "grep"), (r as Parsed).programs)
    }

    fun `test windows rejects expansions and keywords`() {
        for (s in listOf("echo %PATH%", "echo ^a", "(echo a)", "call x.bat", "start x", "for %i in (a) do x", "set A=1", "setx A 1", "cmd /c dir", "powershell -c x")) {
            assertUnparseable(s, windows = true)
        }
    }
}
