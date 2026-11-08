import type { HostPort } from "@stewart/kernel";
import type { ProjectPaths } from "./projectPaths.js";
import { ToolRegistry } from "./types.js";
import { FindFiles, GetProblems, ListCodeFiles, ReadFile, Search } from "./fsRead.js";
import { ApplyPatch, EditFile, WriteFile } from "./fsWrite.js";
import { GetDiff, RunTerminal } from "./process.js";
import { GenerateImage, ReadImage, type ImageGenerator } from "./media.js";

export interface ProjectToolsDeps {
  /** Channel-backed image generation; absent → SVG/Mermaid fallback only. */
  generateImage?: ImageGenerator;
}

export function projectTools(host: Pick<HostPort, "diag" | "files" | "proc">, paths: ProjectPaths, deps: ProjectToolsDeps = {}): ToolRegistry {
  return new ToolRegistry([
    new ReadFile(host, paths),
    new FindFiles(host, paths),
    new ListCodeFiles(host, paths),
    new Search(host, paths),
    new GetProblems(host, paths),
    new GetDiff(host, paths),
    new ReadImage(host, paths),
    new WriteFile(host, paths),
    new EditFile(host, paths),
    new ApplyPatch(host, paths),
    new RunTerminal(host, paths),
    new GenerateImage(host, paths, deps.generateImage),
  ]);
}
