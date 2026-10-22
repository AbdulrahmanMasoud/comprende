// The learner profile: what one person knows, kept in their home folder
// (~/.comprende/profile.json, or $COMPRENDE_HOME) and shared by all their projects.

import * as fs from "node:fs";
import * as os from "node:os";
import { dirname, join, resolve } from "node:path";
import { dict, isRecord, today } from "../util.js";
import {
  atomicWrite,
  checkNoSecrets,
  expandHome,
  isoDate,
  NOTE_MAX_CHARS,
  StoreError,
  slug,
  truncate,
} from "./common.js";

const PROFILE_VERSION = 1;
const MAX_EVIDENCE = 3; // notes kept per topic: the latest matter most
const MAX_LISTED = 40; // topic names shown per group in learning_context

export const EVENTS = ["knows", "learning", "explained"] as const;
type TopicEvent = (typeof EVENTS)[number];
const LEVELS = ["comfortable", "learning"] as const;
type Level = (typeof LEVELS)[number];

interface Topic {
  level: Level | null;
  explained_on: string | null;
  evidence: string[];
  checkpoints: { right: number; wrong: number; streak: number };
  updated: string;
}

interface Profile {
  version: number;
  preferences: Record<string, string>;
  topics: Record<string, Topic>;
}

function profilePath(): string {
  const home = process.env.COMPRENDE_HOME;
  return join(home ? resolve(expandHome(home)) : join(os.homedir(), ".comprende"), "profile.json");
}

const emptyProfile = (): Profile => ({ version: PROFILE_VERSION, preferences: dict(), topics: dict() });

function freshTopic(): Topic {
  return {
    level: null,
    explained_on: null,
    evidence: [],
    checkpoints: { right: 0, wrong: 0, streak: 0 },
    updated: today(),
  };
}

const countOrZero = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** A topic as stored, with anything missing or of the wrong type (a hand edit) reset to its default. */
function normalizeTopic(raw: Record<string, unknown>): Topic {
  const cp = isRecord(raw.checkpoints) ? raw.checkpoints : {};
  return {
    level: LEVELS.includes(raw.level as Level) ? (raw.level as Level) : null,
    explained_on: typeof raw.explained_on === "string" ? raw.explained_on : null,
    evidence: Array.isArray(raw.evidence) ? raw.evidence.filter((n): n is string => typeof n === "string") : [],
    checkpoints: { right: countOrZero(cp.right), wrong: countOrZero(cp.wrong), streak: countOrZero(cp.streak) },
    updated: typeof raw.updated === "string" ? raw.updated : "",
  };
}

/** The profile in `text`, or null when it isn't a JSON object at all. */
function parseProfile(text: string): Profile | null {
  let data: unknown;
  try {
    // Prototype-free objects all the way down, so names are only ever own keys.
    data = JSON.parse(text, (_key, value) => (isRecord(value) ? Object.assign(dict(), value) : value));
  } catch {
    return null;
  }
  if (!isRecord(data)) return null;
  const profile = emptyProfile();
  if (typeof data.version === "number") profile.version = data.version;
  for (const [key, value] of Object.entries(isRecord(data.preferences) ? data.preferences : {})) {
    if (typeof value === "string") profile.preferences[key] = value;
  }
  for (const [key, value] of Object.entries(isRecord(data.topics) ? data.topics : {})) {
    if (isRecord(value)) profile.topics[key] = normalizeTopic(value);
  }
  return profile;
}

const UTF8 = new TextDecoder("utf-8", { fatal: true });

export function loadProfile(): Profile {
  const path = profilePath();
  if (!fs.existsSync(path)) return emptyProfile();
  let text: string | null;
  try {
    text = UTF8.decode(fs.readFileSync(path));
  } catch (e) {
    if (!(e instanceof TypeError)) throw e; // a read error, not invalid UTF-8
    text = null;
  }
  const profile = text === null ? null : parseProfile(text);
  if (profile) return profile;
  // Keep the broken file for the user; start fresh rather than fail every call.
  fs.renameSync(path, join(dirname(path), `profile.broken-${today()}.json`));
  return emptyProfile();
}

function saveProfile(profile: Profile): void {
  atomicWrite(profilePath(), `${JSON.stringify(profile, null, 2)}\n`);
}

function topicEntry(profile: Profile, name: string): [string, Topic] {
  const key = slug(name);
  if (!key) throw new StoreError("Topic name is empty.");
  if (!Object.hasOwn(profile.topics, key)) profile.topics[key] = freshTopic();
  return [key, profile.topics[key]!];
}

function addEvidence(entry: Topic, note: string, project: string): void {
  const text = note.trim();
  if (text) {
    const where = project ? ` · ${project}` : "";
    entry.evidence = [...entry.evidence, `${today()}${where} · ${truncate(text, NOTE_MAX_CHARS)}`].slice(-MAX_EVIDENCE);
  }
  entry.updated = today();
}

export function recordTopic(topic: string, event: TopicEvent, note = "", project = ""): string {
  if (!EVENTS.includes(event)) throw new StoreError(`event must be one of ${EVENTS.join(", ")}.`);
  checkNoSecrets(note);
  const profile = loadProfile();
  const [key, entry] = topicEntry(profile, topic);
  if (event === "knows") entry.level = "comfortable";
  else if (event === "learning") entry.level = "learning";
  else {
    // Remember that it was covered; don't guess their level.
    entry.explained_on = today();
    entry.level ??= "learning";
  }
  addEvidence(entry, note, project);
  saveProfile(profile);
  return `Recorded \`${key}\`: level=${entry.level}${entry.explained_on ? `, explained ${entry.explained_on}` : ""}`;
}

/**
 * Two right answers in a row → comfortable; a wrong one → learning.
 *
 * Deliberately simple and visible, so the user can predict and correct it.
 */
export function recordCheckpoint(topic: string, question: string, correct: boolean, project = ""): string {
  checkNoSecrets(question);
  const profile = loadProfile();
  const [key, entry] = topicEntry(profile, topic);
  const cp = entry.checkpoints;
  if (correct) {
    cp.right += 1;
    cp.streak = Math.max(cp.streak, 0) + 1;
    if (cp.streak >= 2) entry.level = "comfortable";
  } else {
    cp.wrong += 1;
    cp.streak = 0;
    entry.level = "learning";
  }
  entry.level ??= "learning";
  addEvidence(entry, `checkpoint ${correct ? "✓" : "✗"}: ${question}`, project);
  saveProfile(profile);
  return `\`${key}\` is now ${entry.level} (${cp.right} right, ${cp.wrong} wrong).`;
}

export function setPreference(key: string, value: string): string {
  const k = slug(key);
  if (!k) throw new StoreError("Preference key is empty.");
  checkNoSecrets(value);
  const profile = loadProfile();
  let message: string;
  if (value.trim()) {
    const v = truncate(value.trim(), NOTE_MAX_CHARS);
    profile.preferences[k] = v;
    message = `Preference \`${k}\` = ${v}`;
  } else {
    delete profile.preferences[k];
    message = `Preference \`${k}\` cleared.`;
  }
  saveProfile(profile);
  return message;
}

export function profileSummary(profile: Profile): string[] {
  const prefs = Object.entries(profile.preferences);
  const topics = Object.entries(profile.topics);
  if (!topics.length && !prefs.length)
    return ["No profile yet. Calibrate from the conversation and record what you learn."];
  // Most recently touched first: recent evidence is the most reliable.
  const ordered = topics.sort(([, a], [, b]) => (a.updated < b.updated ? 1 : a.updated > b.updated ? -1 : 0));
  const names = (list: [string, Topic][]): string => {
    const shown = list.slice(0, MAX_LISTED).map(([k]) => k);
    const more = list.length - shown.length;
    return shown.length ? shown.join(", ") + (more > 0 ? ` (+${more} more)` : "") : "—";
  };
  const comfortable = ordered.filter(([, t]) => t.level === "comfortable");
  const learning = ordered.filter(([, t]) => t.level === "learning");
  const explained = ordered.filter(([, t]) => t.explained_on);
  const out: string[] = [];
  if (prefs.length) out.push(`Preferences: ${prefs.map(([k, v]) => `${k}=${v}`).join("; ")}`);
  out.push(`Comfortable: ${names(comfortable)}`, "Learning:");
  if (learning.length) {
    for (const [k, t] of learning.slice(0, MAX_LISTED)) out.push(`- ${k} — ${t.evidence.at(-1) ?? "no notes"}`);
  } else {
    out.push("- —");
  }
  out.push(`Explained before (don't repeat; refer back): ${names(explained)}`);
  return out;
}

export function progressReport(): string {
  const topics = Object.entries(loadProfile().topics);
  if (!topics.length) return "Nothing tracked yet.";
  const namesWhere = (keep: (t: Topic) => boolean): string[] =>
    topics
      .filter(([, t]) => keep(t))
      .map(([k]) => k)
      .sort();
  const comfortable = namesWhere((t) => t.level === "comfortable");
  const learning = namesWhere((t) => t.level === "learning");
  const d = new Date();
  const weekAgo = isoDate(d.getFullYear(), d.getMonth(), d.getDate() - 7);
  const recent = namesWhere((t) => t.updated >= weekAgo);
  const right = topics.reduce((n, [, t]) => n + t.checkpoints.right, 0);
  const wrong = topics.reduce((n, [, t]) => n + t.checkpoints.wrong, 0);
  const out = [
    "# Learning progress",
    `Comfortable (${comfortable.length}): ${comfortable.join(", ") || "—"}`,
    `Still learning (${learning.length}): ${learning.join(", ") || "—"}`,
    `Touched in the last 7 days: ${recent.join(", ") || "—"}`,
  ];
  if (right + wrong) out.push(`Checkpoints: ${right}/${right + wrong} correct`);
  const shaky = namesWhere((t) => t.checkpoints.wrong > t.checkpoints.right);
  if (shaky.length) out.push(`Worth revisiting: ${shaky.join(", ")}`);
  return out.join("\n");
}
