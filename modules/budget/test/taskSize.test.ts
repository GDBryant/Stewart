import { describe, expect, it } from "vitest";
import { classifyTask } from "../src/api.js";

describe("classifyTask", () => {
  it("flags obvious small tasks as quick", () => {
    expect(classifyTask("write a bash script that tars logs and rsyncs them to the backup server")).toBe("quick");
    expect(classifyTask("explain this regex to me")).toBe("quick");
  });

  it("flags large cross-cutting work as deep", () => {
    expect(
      classifyTask("refactor the auth layer across all packages and migrate every session store", {
        workspaceSize: "large",
        orchestrated: true,
      }),
    ).toBe("deep");
  });

  it("leaves ambiguous prompts at normal", () => {
    expect(classifyTask("add a save button to the dialog")).toBe("normal");
    expect(classifyTask("write a bash script that refactors the whole build pipeline", { orchestrated: true })).toBe("normal");
  });

  it("weighs mentions, attachments and long prompts toward deep", () => {
    expect(classifyTask("compare @a.ts @b.ts @c.ts", { hasAttachments: true, orchestrated: true })).toBe("deep");
    expect(classifyTask("x".repeat(1300))).toBe("deep");
  });
});
