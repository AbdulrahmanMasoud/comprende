// What every MCP tool is made of: its description, annotations and argument schema,
// the error a model can read and fix, and the helpers that describe its arguments.
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod";
import { StoreError } from "../store/common.js";

/** A failure the model can read and fix; becomes an `isError` tool result. */
export class ToolError extends Error {
  override name = "ToolError";
}

/** Run a store call, turning its refusals into tool errors the model can read and fix. */
export async function call(fn: () => string): Promise<string> {
  try {
    return fn();
  } catch (e) {
    if (e instanceof StoreError) throw new ToolError(e.message);
    throw e;
  }
}

export const READ_ONLY: ToolAnnotations = { readOnlyHint: true, openWorldHint: false };
export const WRITES: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };

const title = (name: string) =>
  name
    .split("_")
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(" ");
export const str = (field: string, description: string) =>
  z
    .string()
    .describe(description)
    .meta({ title: title(field) });

export interface Tool {
  description: string;
  annotations: ToolAnnotations;
  shape: z.ZodRawShape;
  /** Validates `args` against `shape` (filling defaults), then runs the tool. */
  run: (args: unknown) => Promise<string>;
}

/** A tool whose `run` gets its arguments typed from `shape`. */
export function tool<S extends z.ZodRawShape>(def: {
  description: string;
  annotations: ToolAnnotations;
  shape: S;
  run: (args: z.output<z.ZodObject<S>>) => Promise<string>;
}): Tool {
  const schema = z.object(def.shape);
  return { ...def, run: (args) => def.run(schema.parse(args)) };
}
