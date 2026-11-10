import type { ToolCall } from "@stewart/kernel";
import { isObj, strictDecode } from "./jsonRepair.js";
import { ToolCallParseException, known, newCallId, type SchemaMap } from "./types.js";
import { readCall } from "./tagParsers.js";

export interface RawCall {
  id?: string | null;
  name: string;
  arguments: string;
}

function repairKnownCall(raw: RawCall, name: string, argsText: string, schema: SchemaMap): ToolCall[] {
  let args: unknown;
  try {
    args = strictDecode(argsText);
  } catch {
    throw new ToolCallParseException("TC-ARGS-INVALID");
  }
  if (!isObj(args)) throw new ToolCallParseException("TC-ARGS-INVALID");
  return [{ id: raw.id ?? newCallId(), name, arguments: args }];
}

function nativeCallText(name: string, argsText: string): string {
  const trimmedArgs = argsText.trim();
  return name + (trimmedArgs !== "" && trimmedArgs !== "{}" && !name.includes("{") ? trimmedArgs : "");
}

function repairNativePiece(piece: string, schema: SchemaMap): ToolCall {
  const parsed = readCall(piece, schema);
  if (parsed == null || !known(parsed[0], schema)) throw new ToolCallParseException("TC-NATIVE-INVALID");
  return { id: newCallId(), name: parsed[0], arguments: parsed[1] };
}

export function repairNativeCall(raw: RawCall, schema: SchemaMap): ToolCall[] {
  const name = raw.name;
  const argsText = raw.arguments;
  if (name.trim() === "") throw new ToolCallParseException("TC-NATIVE-INVALID");
  if (known(name, schema)) return repairKnownCall(raw, name, argsText, schema);
  const text = nativeCallText(name, argsText);
  if (!text.includes("{") && !text.includes("<")) throw new ToolCallParseException("TC-NATIVE-INVALID");
  const repaired: ToolCall[] = [];
  for (const piece of text.replace(/<\/tool_call>/g, "").split("<tool_call>")) {
    if (piece.trim() === "") continue;
    repaired.push(repairNativePiece(piece, schema));
  }
  if (repaired.length === 0) throw new ToolCallParseException("TC-NATIVE-INVALID");
  return repaired;
}
