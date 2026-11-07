import { mediaTypeFor, type HostPort, type Json, type ToolSpec } from "@stewart/kernel";
import { IMAGE_LIMITS } from "@stewart/context";
import type { ToolPreview } from "@stewart/permissions";
import { ProjectPaths } from "./projectPaths.js";
import { arg, schema, str, ProjectTool } from "./toolBase.js";

export class ReadImage extends ProjectTool {
  spec: ToolSpec = {
    name: "ReadImage",
    description: "Read an image file and return it for a vision model to describe",
    parameters: schema({ path: str }, ["path"]),
  };
  requiresApproval = false;

  async execute(args: Json): Promise<{ text: string; images: string[] }> {
    const rel = this.paths.resolve(arg(args, "path"));
    const mediaType = mediaTypeFor(rel);
    if (!mediaType) throw new Error(`not an image (png/jpg/jpeg/gif/webp): ${rel}`);
    if (!(await this.paths.exists(rel))) throw new Error(`file not found: ${rel}`);
    const st = await this.paths.stat(rel);
    if (st.size > IMAGE_LIMITS.maxReadBytes) throw new Error(`file too large: ${rel}`);
    if (st.size > IMAGE_LIMITS.maxBytes) throw new Error(`image exceeds ${IMAGE_LIMITS.maxBytes} bytes: ${rel}`);
    const { base64 } = await this.host.files.readBinary(rel);
    return { text: `image ${rel} (${st.size} bytes)`, images: [`data:${mediaType};base64,${base64}`] };
  }
}

export type ImageGenerator = (prompt: string) => Promise<{ base64: string } | undefined>;

export class GenerateImage extends ProjectTool {
  constructor(host: Pick<HostPort, "diag" | "files" | "proc">, paths: ProjectPaths, private generate?: ImageGenerator) {
    super(host, paths);
  }
  spec: ToolSpec = {
    name: "GenerateImage",
    description: "Generate an image via the channel's image endpoint, or write SVG/Mermaid to an asset path",
    parameters: schema({ path: str, prompt: str, content: str }, ["path", "prompt"]),
  };
  requiresApproval = true;
  readonly category = "OTHER" as const;

  async preview(args: Json): Promise<ToolPreview> {
    this.paths.resolve(arg(args, "path"));
    return { kind: "other", category: "OTHER" };
  }

  async execute(args: Json): Promise<string> {
    const rel = this.paths.resolve(arg(args, "path"));
    const prompt = arg(args, "prompt");
    if (this.generate) {
      const img = await this.generate(prompt);
      if (img) {
        await this.host.files.writeBinary(rel, img.base64);
        return `generated image ${rel}`;
      }
    }
    const raw = typeof args["content"] === "string" && args["content"]
      ? String(args["content"])
      : `<svg xmlns="http://www.w3.org/2000/svg"><desc>${prompt.replace(/[<>&]/g, "")}</desc></svg>`;
    await this.host.files.edit({ path: rel, content: raw });
    return `generated ${rel}`;
  }
}
