import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface FakeDoc {
  uri: Uri;
  isDirty: boolean;
  version: number;
  text: string;
  getText(): string;
  positionAt(offset: number): Position;
  save(): Promise<boolean>;
}

export const saveCalls: string[] = [];
export let saveResult = true;
export const openErrors: string[] = [];

export function setSaveResult(ok: boolean): void {
  saveResult = ok;
}

export function resetVscode(): void {
  workspace.textDocuments.length = 0;
  workspace.workspaceFolders = undefined;
  saveCalls.length = 0;
  saveResult = true;
}

export class Uri {
  scheme = "file";
  fsPath: string;
  path: string;
  private constructor(p: string, scheme = "file") {
    this.fsPath = p;
    this.path = p;
    this.scheme = scheme;
  }
  static file(p: string): Uri {
    return new Uri(p);
  }
  static parse(s: string): Uri {
    return new Uri(s, s.split("://")[0] ?? "file");
  }
  static joinPath(base: Uri, ...segs: string[]): Uri {
    return new Uri(path.join(base.fsPath, ...segs));
  }
  with(u: { path?: string; scheme?: string }): Uri {
    const next = new Uri(u.path ?? this.fsPath, u.scheme ?? this.scheme);
    return next;
  }
}

export class Position {
  constructor(public offset: number) {}
}

export class Range {
  constructor(public start: Position, public end: Position) {}
}

interface EditOp {
  uri: Uri;
  start: number;
  end: number;
  text: string;
}

export class WorkspaceEdit {
  readonly ops: EditOp[] = [];
  replace(uri: Uri, range: Range, text: string): void {
    this.ops.push({ uri, start: range.start.offset, end: range.end.offset, text });
  }
}

export const FileType = { File: 1, Directory: 2 } as const;

export enum DiagnosticSeverity {
  Error = 0,
  Warning = 1,
  Information = 2,
  Hint = 3,
}

function docFor(uri: Uri, text: string): FakeDoc {
  const doc: FakeDoc = {
    uri,
    isDirty: false,
    version: 1,
    text,
    getText: () => doc.text,
    positionAt: (offset: number) => new Position(offset),
    save: async () => {
      saveCalls.push(uri.fsPath);
      if (!saveResult) return false;
      await fs.writeFile(uri.fsPath, doc.text, "utf8");
      doc.isDirty = false;
      return true;
    },
  };
  return doc;
}

export const workspace = {
  workspaceFolders: undefined as { uri: Uri }[] | undefined,
  textDocuments: [] as FakeDoc[],
  isTrusted: true,
  async openTextDocument(uri: Uri): Promise<FakeDoc> {
    const open = workspace.textDocuments.find((d) => d.uri.fsPath === uri.fsPath);
    if (open) return open;
    const text = await fs.readFile(uri.fsPath, "utf8").catch((e) => {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`file not found: ${uri.fsPath}`);
      throw e;
    });
    const doc = docFor(uri, text);
    workspace.textDocuments.push(doc);
    return doc;
  },
  async applyEdit(edit: WorkspaceEdit): Promise<boolean> {
    const byDoc = new Map<string, EditOp[]>();
    for (const op of edit.ops) (byDoc.get(op.uri.fsPath) ?? byDoc.set(op.uri.fsPath, []).get(op.uri.fsPath)!).push(op);
    for (const [fsPath, ops] of byDoc) {
      const doc = workspace.textDocuments.find((d) => d.uri.fsPath === fsPath);
      if (!doc) return false;
      for (const op of [...ops].sort((a, b) => b.start - a.start)) {
        doc.text = doc.text.slice(0, op.start) + op.text + doc.text.slice(op.end);
      }
      doc.isDirty = true;
      doc.version++;
    }
    return true;
  },
  fs: {
    stat: async (uri: Uri) => {
      const s = await fs.stat(uri.fsPath);
      return { size: s.size, type: s.isDirectory() ? FileType.Directory : FileType.File };
    },
    readDirectory: async (uri: Uri) => {
      const ents = await fs.readdir(uri.fsPath, { withFileTypes: true });
      return ents.map((e) => [e.name, e.isDirectory() ? FileType.Directory : FileType.File] as [string, number]);
    },
    readFile: async (uri: Uri) => new Uint8Array(await fs.readFile(uri.fsPath)),
    writeFile: async (uri: Uri, data: Uint8Array) => fs.writeFile(uri.fsPath, data),
    rename: async (from: Uri, to: Uri) => fs.rename(from.fsPath, to.fsPath),
  },
};

export const window = {
  activeTextEditor: undefined as unknown,
  createOutputChannel: () => ({ appendLine: () => {} }),
};

export const languages = {
  getDiagnostics: () => [] as [Uri, { range: { start: { line: number } }; message: string; severity: number }[]][],
};

export const commands = {
  executeCommand: async () => undefined,
};
