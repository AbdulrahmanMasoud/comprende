// Shared by the memory store: its error type, small text helpers, path
// resolution, the secret check and atomic writes.
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import { basename, dirname, join, resolve } from "node:path";

export const NOTE_MAX_CHARS = 200; // per evidence note and preference value
const SLUG_MAX_CHARS = 60;

/** A request the store refuses; the message is safe to show the model. */
export class StoreError extends Error {
  override name = "StoreError";
}

/** An object with no prototype: a topic named "constructor" is just a topic. */
export const dict = <T>(): Record<string, T> => Object.create(null) as Record<string, T>;
export const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** The first `n` characters (code points), never half of a surrogate pair. */
export const truncate = (s: string, n: number): string => (s.length <= n ? s : Array.from(s).slice(0, n).join(""));

export const lines = (s: string): string[] => s.split(/\r\n|\r|\n/);

export function today(): string {
  const d = new Date();
  return isoDate(d.getFullYear(), d.getMonth(), d.getDate());
}

export function isoDate(year: number, month: number, day: number): string {
  const d = new Date(year, month, day);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Lowercase ASCII words joined by "-", at most 60 characters: topic and file names. */
export function slug(text: string): string {
  const s = text
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return truncate(s, SLUG_MAX_CHARS);
}

export const expandHome = (p: string): string => (p === "~" || p.startsWith("~/") ? os.homedir() + p.slice(1) : p);

/** A path from the user or the model: `~` expanded, made absolute, symlinks resolved where it exists. */
export function resolveUserPath(p: string): string {
  const abs = resolve(expandHome(p));
  try {
    return fs.realpathSync(abs);
  } catch {
    return abs;
  }
}

export const isDirectory = (p: string): boolean => fs.statSync(p, { throwIfNoEntry: false })?.isDirectory() ?? false;
export const isFile = (p: string): boolean => fs.statSync(p, { throwIfNoEntry: false })?.isFile() ?? false;
export const isSymlink = (p: string): boolean => fs.lstatSync(p, { throwIfNoEntry: false })?.isSymbolicLink() ?? false;

// Things that look like credentials. Memory files get committed and shared, so
// they're refused in code rather than trusting a prompt to remember. A token
// glued to other letters or digits isn't a token on its own, hence the
// boundaries: no letter, digit or "_" right before (or after) it.
const START = "(?<![\\p{L}\\p{N}_])";
const END = "(?![\\p{L}\\p{N}_])";
const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
  new RegExp(`${START}AKIA[0-9A-Z]{16}${END}`, "u"), // AWS access key
  new RegExp(`${START}(sk|pk|rk)[-_](live|test|proj|ant)?[-_]?[A-Za-z0-9]{16,}`, "u"), // API keys
  new RegExp(`${START}gh[pousr]_[A-Za-z0-9]{30,}${END}`, "u"), // GitHub tokens
  new RegExp(`${START}xox[abprs]-[A-Za-z0-9-]{10,}`, "u"), // Slack tokens
  new RegExp(`${START}(password|passwd|secret|api[_-]?key|token)\\s*[:=]\\s*\\S{6,}`, "iu"),
  new RegExp(`${START}[a-z]+://[^/\\s:]+:[^@\\s]+@`, "iu"), // user:pass@host URLs
];

export function checkNoSecrets(...texts: string[]): void {
  for (const text of texts) {
    if (SECRET_PATTERNS.some((pattern) => pattern.test(text))) {
      throw new StoreError(
        "Refused: this looks like it contains a credential. Memory files must never hold secrets — rephrase without it.",
      );
    }
  }
}

/**
 * Write to a temp file, then rename it into place. rename is atomic, so a
 * crash mid-write leaves the old file intact instead of a half-written one.
 * The file is created with mode 0600: the profile is personal.
 */
export function atomicWrite(path: string, content: string): void {
  const dir = dirname(path);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${basename(path)}.${randomUUID()}.tmp`);
  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW;
  let fd: number | null = fs.openSync(tmp, flags, 0o600);
  try {
    const buf = Buffer.from(content);
    for (let off = 0; off < buf.length; ) off += fs.writeSync(fd, buf, off);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmp, path);
  } catch (e) {
    if (fd !== null) fs.closeSync(fd);
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}
