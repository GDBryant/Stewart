/** Shell command splitter: the programs a command line launches, or null when unparseable/dangerous. */
const SHELLS = new Set(["sh", "bash", "dash", "zsh", "ksh", "fish", "busybox"]);
const LAUNCHERS = new Set([
  "xargs", "sudo", "doas", "su", "runuser", "env", "command", "builtin", "exec", "eval",
  "time", "timeout", "nice", "nohup", "stdbuf", "setsid", "chroot", "watch", "script",
  "source", ".", "awk", "sed",
]);
const INTERPRETERS = new Set([
  "perl", "ruby", "node", "deno", "bun", "php", "lua", "rscript", "pwsh", "powershell", "osascript",
]);
const SHELL_STATE = new Set([
  "export", "unset", "set", "setx", "alias", "unalias", "typeset", "declare", "readonly",
  "hash", "ulimit", "trap", "cd", "pushd", "popd", "for", "if", "while", "until", "case", "goto",
]);

function baseName(name: string): string {
  return name.split(/[\\/]/).pop()!.toLowerCase().replace(/\.exe$/, "");
}

function dangerous(name: string): boolean {
  const b = baseName(name);
  return (
    SHELLS.has(b) || LAUNCHERS.has(b) || INTERPRETERS.has(b) || SHELL_STATE.has(b) ||
    b.startsWith("python") || b.startsWith("pypy")
  );
}

type ScanState = "none" | "single" | "double";

class ShellScanner {
  private readonly segments: string[] = [];
  private cur = "";
  private state: ScanState = "none";
  private i = 0;

  constructor(private readonly command: string) {}

  scan(): string[] | null {
    while (this.i < this.command.length) {
      const c = this.command[this.i];
      const fatal =
        this.state === "single" ? this.inSingle(c)
        : this.state === "double" ? this.inDouble(c)
        : this.inPlain(c);
      if (fatal) return null;
      this.i++;
    }
    this.segments.push(this.cur);
    return this.state === "none" ? this.segments : null;
  }

  private inSingle(c: string): boolean {
    if (c === "'") this.state = "none";
    this.cur += c;
    return false;
  }

  private inDouble(c: string): boolean {
    if (c === "\\" && this.i + 1 < this.command.length) {
      this.cur += c + this.command[++this.i];
      return false;
    }
    if (c === '"') this.state = "none";
    this.cur += c;
    return false;
  }

  private inPlain(c: string): boolean {
    if (c === "'") {
      this.state = "single";
      this.cur += c;
      return false;
    }
    if (c === '"') {
      this.state = "double";
      this.cur += c;
      return false;
    }
    if (c === "\\" && this.i + 1 < this.command.length) {
      this.cur += c + this.command[++this.i];
      return false;
    }
    if (c === "`" || (c === "$" && this.command[this.i + 1] === "(")) return true;
    if (c === "&" || c === "|" || c === ";" || c === "\n") {
      this.segments.push(this.cur);
      this.cur = "";
      if ((c === "&" || c === "|") && this.command[this.i + 1] === c) this.i++;
      return false;
    }
    this.cur += c;
    return false;
  }
}

/**
 * Splits a shell command line into the program tokens each sub-command launches.
 * Returns null when anything is unparseable or dangerous — the caller must prompt.
 */
export function splitShellPrograms(command: string): string[] | null {
  const segments = new ShellScanner(command).scan();
  if (segments === null) return null;
  const programs: string[] = [];
  for (const seg of segments) {
    const words = seg.trim().split(/\s+/).filter(Boolean);
    let wi = 0;
    while (wi < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[wi])) {
      if (DANGEROUS_VARS.has(words[wi].split("=")[0])) return null;
      wi++;
    }
    if (wi >= words.length) continue;
    const word = words[wi].replace(/^["']|["']$/g, "");
    if (word === "") continue;
    if (dangerous(word)) return null;
    programs.push(baseName(word));
  }
  return programs.length > 0 ? programs : null;
}

const DANGEROUS_VARS = new Set([
  "PATH", "LD_PRELOAD", "LD_LIBRARY_PATH", "DYLD_INSERT_LIBRARIES", "IFS", "BASH_ENV", "ENV",
  "CDPATH", "SHELLOPTS", "GLOBIGNORE", "PYTHONPATH", "PYTHONSTARTUP", "NODE_OPTIONS",
  "PERL5OPT", "RUBYOPT",
]);
