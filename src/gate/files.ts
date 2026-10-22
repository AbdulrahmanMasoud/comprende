// Reading and writing files a repo controls: never through a symlink, never a FIFO,
// never more than a size limit, and atomically when writing.
import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { lstat } from "../util.js";
import { GateError } from "./shared.js";

export const MAX_CONFIG_BYTES = 256 * 1024;

export const MAX_REPORT_BYTES = 4 * 1024 * 1024;

/** Read a repo-controlled file safely: never through a symlink (it could point
 *  at /dev/zero or a secret), never a FIFO, never more than `limit` bytes. */
export function readRepoFile(path: string, limit: number): string {
  const st = lstat(path);
  if (!st || st.isSymbolicLink() || !st.isFile())
    throw new GateError(`${basename(path)} must be a regular file, not a symlink or special file.`);
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(limit + 1);
    let n = 0;
    for (;;) {
      const got = readSync(fd, buf, n, buf.length - n, null);
      if (got === 0) break;
      n += got;
      if (n > limit)
        throw new GateError(`${basename(path)} is larger than ${Math.floor(limit / 1024)} KB — refusing to read it.`);
    }
    return buf.subarray(0, n).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

export function atomicWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const existingMode = (() => {
    try {
      return statSync(path).mode & 0o777;
    } catch {
      return null;
    }
  })();
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);
  try {
    writeFileSync(tmp, content, { encoding: "utf8", mode: 0o666, flag: "wx" }); // umask applies
    if (existingMode !== null) chmodSync(tmp, existingMode);
    renameSync(tmp, path);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      /* already gone */
    }
    throw e;
  }
}
