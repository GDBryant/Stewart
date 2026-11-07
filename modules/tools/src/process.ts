import type { Json, ToolSpec } from "@stewart/kernel";
import type { ToolPreview } from "@stewart/permissions";
import { MAX_COMMAND_OUTPUT } from "./projectPaths.js";
import { arg, optBool, schema, str, bool, ProjectTool } from "./toolBase.js";

export class GetDiff extends ProjectTool {
  spec: ToolSpec = {
    name: "GetDiff",
    description: "Return git diff for the workspace or a file",
    parameters: schema({ path: str, staged: bool }, []),
  };
  requiresApproval = false;

  async execute(args: Json, _preview: ToolPreview | null, signal: AbortSignal): Promise<string> {
    const rel = args["path"] !== undefined ? this.paths.resolve(arg(args, "path")) : undefined;
    const argv = ["git", "diff", ...(optBool(args, "staged") ? ["--staged"] : []), ...(rel ? ["--", rel] : [])];
    let output = "";
    const proc = this.host.proc.run(argv, {
      cwd: this.paths.absolute(""),
      onData: (d) => {
        if (output.length < MAX_COMMAND_OUTPUT) output += d.slice(0, MAX_COMMAND_OUTPUT - output.length);
      },
    });
    const onAbort = () => void proc.killTree();
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    try {
      await proc.done;
      return output.trim() || "no diff";
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }
}

export class RunTerminal extends ProjectTool {
  spec: ToolSpec = {
    name: "RunTerminal",
    description: "Run a shell command",
    parameters: schema({ command: str, cwd: str }, ["command"]),
  };
  requiresApproval = true;

  private cwd(args: Json): string {
    return args["cwd"] !== undefined ? this.paths.resolve(arg(args, "cwd")) : ".";
  }

  async preview(args: Json): Promise<ToolPreview> {
    return { kind: "command", command: arg(args, "command"), cwd: this.cwd(args) };
  }

  async execute(args: Json, preview: ToolPreview | null, signal: AbortSignal): Promise<string> {
    const approved = preview?.kind === "command" ? preview : null;
    if (!approved) throw new Error("missing preview");
    const command = arg(args, "command");
    const cwd = this.cwd(args);
    if (approved.command !== command || approved.cwd !== cwd) {
      throw new Error("command changed since approval");
    }
    const argv = process.platform === "win32" ? ["cmd", "/c", command] : ["/bin/sh", "-c", command];
    let output = "";
    const proc = this.host.proc.run(argv, {
      cwd: this.paths.absolute(cwd === "." ? "" : cwd),
      onData: (d) => {
        if (output.length < MAX_COMMAND_OUTPUT) output += d.slice(0, MAX_COMMAND_OUTPUT - output.length);
      },
    });
    const onAbort = () => void proc.killTree();
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    try {
      const { code } = await proc.done;
      return `exit code: ${code}\n${output}`;
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }
}
