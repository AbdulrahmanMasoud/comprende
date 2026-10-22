// Small helpers shared by the gate and the memory store. Node built-ins only,
// so the gate's bundle can include them.
import { lstatSync, statSync } from "node:fs";

/** An object with no prototype, for maps keyed by names that come from outside
 *  (file paths, topics): a key named "__proto__" or "constructor" is just a key.
 *  Read such maps with `own` and `get` only, never `in` or bare indexing. */
export const dict = <T>(): Record<string, T> => Object.create(null) as Record<string, T>;
export const own = (o: object, k: string): boolean => Object.hasOwn(o, k);
export const get = <T>(o: Record<string, T>, k: string): T | undefined => (Object.hasOwn(o, k) ? o[k] : undefined);

export const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Today's date as YYYY-MM-DD, in local time. */
export function today(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** lstat, or null when the path can't be read. */
export const lstat = (p: string) => {
  try {
    return lstatSync(p);
  } catch {
    return null;
  }
};

export const isSymlink = (p: string): boolean => lstat(p)?.isSymbolicLink() ?? false;

export const isFile = (p: string): boolean => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

export const isDirectory = (p: string): boolean => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};
