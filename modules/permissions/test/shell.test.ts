import { describe, expect, it } from "vitest";
import { splitShellPrograms } from "../src/api.js";

describe("splitShellPrograms characterization", () => {
  it("splits on single &, ||, |, ; and newline", () => {
    expect(splitShellPrograms("ls & wc")).toEqual(["ls", "wc"]);
    expect(splitShellPrograms("false || echo ok")).toEqual(["false", "echo"]);
    expect(splitShellPrograms("ls | wc")).toEqual(["ls", "wc"]);
    expect(splitShellPrograms("ls;wc")).toEqual(["ls", "wc"]);
    expect(splitShellPrograms("ls\nwc")).toEqual(["ls", "wc"]);
    expect(splitShellPrograms("ls |& wc")).toEqual(["ls", "wc"]);
    expect(splitShellPrograms("a ;; b")).toEqual(["a", "b"]);
  });

  it("keeps escaped operators and substitutions inside words", () => {
    expect(splitShellPrograms("echo a\\;b")).toEqual(["echo"]);
    expect(splitShellPrograms("echo a\\&b")).toEqual(["echo"]);
    expect(splitShellPrograms("echo a\\|b")).toEqual(["echo"]);
    expect(splitShellPrograms("echo \\`id\\`")).toEqual(["echo"]);
    expect(splitShellPrograms("echo \\$(id)")).toEqual(["echo"]);
    expect(splitShellPrograms("echo a\\")).toEqual(["echo"]);
  });

  it("does not reject substitutions inside quotes", () => {
    expect(splitShellPrograms('echo "$(id)"')).toEqual(["echo"]);
    expect(splitShellPrograms("echo '`id`'")).toEqual(["echo"]);
    expect(splitShellPrograms("echo 'a\"b' \"c'd\"")).toEqual(["echo"]);
  });

  it("characterizes quoted assignment values", () => {
    expect(splitShellPrograms('FOO="a b" ls')).toEqual(["b"]);
    expect(splitShellPrograms("path=/x ls")).toEqual(["ls"]);
    expect(splitShellPrograms("A=1; B=2")).toBeNull();
  });

  it("rejects on basename, case and extension of dangerous programs", () => {
    expect(splitShellPrograms("/bin/bash -c x")).toBeNull();
    expect(splitShellPrograms("bash.exe -c x")).toBeNull();
    expect(splitShellPrograms("SUDO ls")).toBeNull();
    expect(splitShellPrograms("time ls")).toBeNull();
    expect(splitShellPrograms("echo $((1+2))")).toBeNull();
    expect(splitShellPrograms("echo 'it\\'s'")).toBeNull();
    expect(splitShellPrograms(";")).toBeNull();
    expect(splitShellPrograms("&&")).toBeNull();
    expect(splitShellPrograms("")).toBeNull();
  });

  it("treats redirections and other punctuation as ordinary words", () => {
    expect(splitShellPrograms("echo hi > out.txt")).toEqual(["echo"]);
    expect(splitShellPrograms("> out")).toEqual([">"]);
    expect(splitShellPrograms("echo a>b")).toEqual(["echo"]);
  });
});
