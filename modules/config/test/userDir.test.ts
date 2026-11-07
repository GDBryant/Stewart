import { describe, it, expect } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { sharedUserConfigDir, ensureUserConfigDir } from "../src/api.js";

const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), "stewart-ud-"));
const exists = (p: string) => fs.access(p).then(() => true, () => false);

describe("sharedUserConfigDir", () => {
  it("defaults to ~/.config/stewart", () => {
    expect(sharedUserConfigDir({}, "/home/u", "linux")).toBe("/home/u/.config/stewart");
  });
  it("honours override, XDG and APPDATA in that order", () => {
    expect(sharedUserConfigDir({ STEWART_CONFIG_DIR: "/x", XDG_CONFIG_HOME: "/y" }, "/h", "linux")).toBe("/x");
    expect(sharedUserConfigDir({ XDG_CONFIG_HOME: "/y" }, "/h", "linux")).toBe("/y/stewart");
    expect(sharedUserConfigDir({ APPDATA: "/a" }, "/h", "win32")).toBe(path.join("/a", "stewart"));
    expect(sharedUserConfigDir({ APPDATA: "/a" }, "/h", "linux")).toBe("/h/.config/stewart");
  });
});

describe("ensureUserConfigDir", () => {
  it("creates a missing dir tree with skills/", async () => {
    const root = await tmp();
    const dir = path.join(root, "nested", ".config", "stewart");
    expect(await ensureUserConfigDir(dir)).toBe(dir);
    expect(await exists(path.join(dir, "skills"))).toBe(true);
  });
  it("is idempotent and keeps existing files", async () => {
    const dir = path.join(await tmp(), "s");
    await ensureUserConfigDir(dir);
    await fs.writeFile(path.join(dir, "settings.yaml"), "keep: 1\n");
    await ensureUserConfigDir(dir);
    expect(await fs.readFile(path.join(dir, "settings.yaml"), "utf8")).toBe("keep: 1\n");
  });
  it("migrates legacy files without overwriting; earlier legacy wins", async () => {
    const root = await tmp();
    const dir = path.join(root, "shared");
    const l1 = path.join(root, "l1");
    const l2 = path.join(root, "l2");
    await fs.mkdir(path.join(l1, "skills"), { recursive: true });
    await fs.mkdir(l2, { recursive: true });
    await fs.writeFile(path.join(l1, "settings.yaml"), "from: l1\n");
    await fs.writeFile(path.join(l1, "skills", "a.md"), "A");
    await fs.writeFile(path.join(l2, "settings.yaml"), "from: l2\n");
    await fs.writeFile(path.join(l2, "agents.yaml"), "agents: []\n");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "roles.yaml"), "mine\n");
    await fs.writeFile(path.join(l1, "roles.yaml"), "legacy\n");
    await ensureUserConfigDir(dir, [l1, l2]);
    expect(await fs.readFile(path.join(dir, "settings.yaml"), "utf8")).toBe("from: l1\n");
    expect(await fs.readFile(path.join(dir, "agents.yaml"), "utf8")).toBe("agents: []\n");
    expect(await fs.readFile(path.join(dir, "skills", "a.md"), "utf8")).toBe("A");
    expect(await fs.readFile(path.join(dir, "roles.yaml"), "utf8")).toBe("mine\n");
  });
  it("ignores missing and identical legacy dirs", async () => {
    const root = await tmp();
    const dir = path.join(root, "s");
    await ensureUserConfigDir(dir, [path.join(root, "nope"), dir]);
    expect(await exists(path.join(dir, "settings.yaml"))).toBe(false);
  });
});
