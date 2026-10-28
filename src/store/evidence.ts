// The question log: one line per ownership-check question that was asked and
// judged, kept in the developer's home folder (~/.comprende/evidence/, or
// $COMPRENDE_HOME), never in the repo. The report only carries a count and a
// digest of it, so reviewers can see that questions were asked without ever
// seeing the answers or how many tries it took.

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import { join, resolve } from "node:path";
import { isRecord } from "../util.js";
import { atomicWrite, checkNoSecrets, expandHome, NOTE_MAX_CHARS, StoreError, truncate } from "./common.js";

export const QUESTION_KINDS = ["explain", "predict", "modify", "break", "trace", "summary"] as const;
type Kind = (typeof QUESTION_KINDS)[number];
export const RESULTS = ["understood", "partial", "not_yet"] as const;
type Result = (typeof RESULTS)[number];

interface Entry {
  at: string;
  file: string;
  concept: string;
  kind: Kind;
  question: string;
  result: Result;
}

export interface Evidence {
  questions: number;
  digest: string;
}

const MAX_ENTRIES = 500; // per branch: far more than any real check

function evidenceDir(): string {
  const home = process.env.COMPRENDE_HOME;
  return join(home ? resolve(expandHome(home)) : join(os.homedir(), ".comprende"), "evidence");
}

/** One log per repo and branch. The name is a hash, so no path or branch name leaks into it. */
function logPath(root: string, branch: string): string {
  const key = createHash("sha256").update(`${root}\0${branch}`).digest("hex").slice(0, 32);
  return join(evidenceDir(), `${key}.json`);
}

function readLog(path: string): Entry[] {
  let data: unknown;
  try {
    data = JSON.parse(fs.readFileSync(path, "utf8"));
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];
  return data.filter(
    (e): e is Entry =>
      isRecord(e) &&
      typeof e.at === "string" &&
      typeof e.file === "string" &&
      typeof e.concept === "string" &&
      QUESTION_KINDS.includes(e.kind as Kind) &&
      typeof e.question === "string" &&
      RESULTS.includes(e.result as Result),
  );
}

/** Log one judged question. The answer itself is never stored. */
export function recordAnswer(
  root: string,
  branch: string,
  file: string,
  concept: string,
  kind: string,
  question: string,
  result: string,
): string {
  const f = file.trim().replace(/^\.\//, "");
  const c = truncate(concept.trim(), NOTE_MAX_CHARS);
  const q = truncate(question.trim(), NOTE_MAX_CHARS);
  if (!c || !q) throw new StoreError("Both the concept and the question are needed.");
  if (!QUESTION_KINDS.includes(kind as Kind)) throw new StoreError(`kind must be one of: ${QUESTION_KINDS.join(", ")}`);
  if (!RESULTS.includes(result as Result)) throw new StoreError(`result must be one of: ${RESULTS.join(", ")}`);
  checkNoSecrets(f, c, q);
  const path = logPath(root, branch);
  const log = readLog(path);
  log.push({
    at: new Date().toISOString(),
    file: f,
    concept: c,
    kind: kind as Kind,
    question: q,
    result: result as Result,
  });
  atomicWrite(path, JSON.stringify(log.slice(-MAX_ENTRIES), null, 1));
  const n = log.length;
  return `Recorded (${n} question${n === 1 ? "" : "s"} on this branch so far).`;
}

/** What goes in the report: how many questions were asked, and a digest of the log. Null when none were. */
export function evidenceFor(root: string, branch: string): Evidence | null {
  const log = readLog(logPath(root, branch));
  if (!log.length) return null;
  const digest = createHash("sha256").update(JSON.stringify(log)).digest("hex");
  return { questions: log.length, digest };
}
