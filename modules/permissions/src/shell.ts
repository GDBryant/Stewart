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

/**
 * Splits a shell command line into the program tokens each sub-command launches.
 * Returns null when anything is unparseable or dangerous — the caller must prompt.
 */
export function splitShellPrograms(command: string): string[] | null {
  const segments: string[] = [];
  let cur = "";
  let state: " " | "'" | '"' = " ";
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (state === "'") {
      if (c === "'") state = " ";
      cur += c;
      continue;
    }
    if (state === '"') {
      if (c === "\\" && i + 1 < command.length) {
        cur += c + command[++i];
        continue;
      }
      if (c === '"') state = " ";
      cur += c;
      continue;
    }
    if (c === "'") {
      state = "'";
      cur += c;
      continue;
    }
    if (c === '"') {
      state = '"';
      cur += c;
      continue;
    }
    if (c === "\\" && i + 1 < command.length) {
      cur += c + command[++i];
      continue;
    }
    if (c === "`" || (c === "$" && command[i + 1] === "(")) return null;
    if (c === "&" || c === "|" || c === ";" || c === "\n") {
      segments.push(cur);
      cur = "";
      if ((c === "&" || c === "|") && command[i + 1] === c) i++;
      continue;
    }
    cur += c;
  }
  segments.push(cur);
  if (state !== " ") return null;
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
