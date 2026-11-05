import type { ConfigLayer } from "./loader.js";

/** Host-supplied config persistence. read() returns raw YAML per file;
 * write() must persist atomically (temp file + rename). */
export interface ConfigStore {
  read(): Promise<ConfigLayer>;
  write(file: string, yaml: string): Promise<void>;
}
