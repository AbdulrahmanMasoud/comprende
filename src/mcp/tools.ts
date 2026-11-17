// The MCP server's tools: what each one tells the model, and the store call or gate
// command it runs. A store's refusals become tool errors here, the gate's in run-gate.ts.
import * as z from "zod";
import { StoreError } from "../store/common.js";
import { EVENTS, progressReport, recordCheckpoint, recordTopic, setPreference } from "../store/profile.js";
import { addDecision, learningContext, searchDecisions, updateMap } from "../store/project.js";
import { gateCli, option } from "./run-gate.js";
import { READ_ONLY, str, type Tool, ToolError, tool, WRITES } from "./tool-definition.js";

/** Run a store call, turning its refusals into tool errors the model can read and fix. */
async function call(fn: () => string): Promise<string> {
  try {
    return fn();
  } catch (e) {
    if (e instanceof StoreError) throw new ToolError(e.message);
    throw e;
  }
}

const RepoRoot = str("repo_root", "Absolute path to the project's root folder.");
const Topic = str("topic", "Short concept name, e.g. 'react hooks', 'sql indexes', 'asyncio cancellation'.");
const Note = str("note", "Neutral evidence, e.g. 'asked what an image layer is'. Not a judgment.");
const Branch = (field: string) =>
  str(
    field,
    "Branch the PR will come from, if it differs from the current " +
      "local branch (e.g. pushed as another name). Empty = current branch.",
  );
const Base = (field: string) =>
  str(
    field,
    "Base ref the PR targets, e.g. 'origin/develop' or 'upstream/main' for a fork. Empty = from config / auto-detect.",
  );

export const TOOLS: Record<string, Tool> = {
  learning_context: tool({
    description:
      "Everything needed to calibrate explanations, in one call: the learner's\n" +
      "known/learning/already-explained topics and preferences, plus this project's\n" +
      "map and decision index. Call once at the start of a session.",
    annotations: READ_ONLY,
    shape: { repo_root: str("repo_root", "Absolute project path; empty for the profile only.").default("") },
    run: (a) => call(() => learningContext(a.repo_root)),
  }),

  record_topic: tool({
    description: "Update what the learner knows about one topic. Applies across all their projects.",
    annotations: WRITES,
    shape: {
      topic: Topic,
      event: z
        .enum(EVENTS)
        .describe(
          "knows = showed they understand it; learning = showed they're new to it; " +
            "explained = you just explained it (so don't repeat it later).",
        )
        .meta({ title: "Event" }),
      note: Note.default(""),
      repo_root: str("repo_root", "Optional project path, kept as context for the note.").default(""),
    },
    run: (a) => {
      const project = a.repo_root.replace(/\/+$/, "").split("/").pop() ?? "";
      return call(() => recordTopic(a.topic, a.event, a.note, project));
    },
  }),

  record_checkpoint: tool({
    description:
      "Log the result of a checkpoint question. Two correct in a row marks the\n" +
      "topic comfortable; a wrong answer marks it learning.",
    annotations: WRITES,
    shape: {
      topic: Topic,
      question: str("question", "The quick check you asked, in one line."),
      correct: z.boolean().describe("Whether their answer showed understanding.").meta({ title: "Correct" }),
    },
    run: (a) => call(() => recordCheckpoint(a.topic, a.question, a.correct)),
  }),

  set_preference: tool({
    description:
      "Save something the user explicitly asked for about how to explain. Only\n" + "what they said, never inferred.",
    annotations: WRITES,
    shape: {
      key: str("key", "e.g. 'language', 'verbosity', 'analogies'."),
      value: str("value", "e.g. 'Egyptian Arabic', 'short'. Empty clears it."),
    },
    run: (a) => call(() => setPreference(a.key, a.value)),
  }),

  progress_report: tool({
    description:
      "Summary of the learner's progress: comfortable vs. still-learning topics,\n" +
      "recent activity, checkpoint accuracy, and what's worth revisiting. Use when\n" +
      "the user asks what they've learned.",
    annotations: READ_ONLY,
    shape: {},
    run: () => call(() => progressReport()),
  }),

  search_decisions: tool({
    description:
      "Find the project's recorded decisions relevant to what you're about to\n" +
      "change, so you explain within past reasoning instead of contradicting it.",
    annotations: READ_ONLY,
    shape: {
      repo_root: RepoRoot,
      query: str("query", "Keywords about the area you're touching, e.g. 'cache redis invalidation'. Empty lists all."),
      limit: z.number().int().min(1).max(10).default(3).meta({ title: "Limit" }),
    },
    run: (a) => call(() => searchDecisions(a.repo_root, a.query, a.limit)),
  }),

  add_decision: tool({
    description:
      "Record a decision with lasting weight as a numbered file in\n" +
      ".learning/decisions/. Tell the user in one line when you do.",
    annotations: WRITES,
    shape: {
      repo_root: RepoRoot,
      title: str("title", "Short, e.g. 'Sliding-window rate limit in Redis'."),
      context: str("context", "The problem, in one or two lines."),
      decision: str("decision", "What was chosen."),
      alternatives: z
        .array(z.string())
        .describe("Each rejected option with why, e.g. 'fixed window — 2x bursts at edges'.")
        .meta({ title: "Alternatives" }),
      consequences: str("consequences", "What the team now has to live with."),
    },
    run: (a) => call(() => addDecision(a.repo_root, a.title, a.context, a.decision, a.alternatives, a.consequences)),
  }),

  update_map: tool({
    description:
      "Replace the project map in .learning/map.md and stamp today's date.\n" +
      "Update it when structure changes or you find a new gotcha.",
    annotations: WRITES,
    shape: {
      repo_root: RepoRoot,
      content: str("content", "The full map: entry points, core modules, data flow, gotchas. Max 40 lines."),
    },
    run: (a) => call(() => updateMap(a.repo_root, a.content)),
  }),

  gate_status: tool({
    description:
      "Ownership check status of the current change: each changed file is new,\n" +
      "stale (changed since it was verified), or ok, with sensitive, ignored and\n" +
      "untracked files marked, plus the exact list that must be verified before\n" +
      "saving, and whether the change counts as small (then ask one question; the\n" +
      "summary minimum is lower). Use before the final check to know what to ask about.",
    annotations: READ_ONLY,
    shape: { repo_root: RepoRoot, base: Base("base").default(""), branch: Branch("branch").default("") },
    run: (a) => gateCli(a.repo_root, ["status", ...option("base", a.base), ...option("branch", a.branch)]),
  }),

  save_check_report: tool({
    description:
      "Save the ownership report after the final check passes. It fingerprints\n" +
      "every changed file so CI can tell if code changed afterwards. Refuses if a\n" +
      "sensitive or changed-since-last-report file isn't verified — that refusal\n" +
      "lists what is left to ask about.",
    annotations: WRITES,
    shape: {
      repo_root: RepoRoot,
      summary: str(
        "summary",
        "The developer's OWN summary of what changed, why, and what could " +
          "break — their words, not yours. Fixing typos is fine.",
      ),
      verified: z
        .record(z.string(), z.array(z.string()))
        .describe(
          "File path → concepts the developer demonstrably " +
            "understands, e.g. {'src/rateLimit.js': ['sliding-window math', " +
            "'fail-open when Redis is down']}. No scores or mistakes.",
        )
        .meta({ title: "Verified" }),
      base: Base("base").default(""),
      branch: Branch("branch").default(""),
    },
    run: (a) => {
      const payload = JSON.stringify({ summary: a.summary, verified: a.verified });
      return gateCli(a.repo_root, ["save", ...option("base", a.base), ...option("branch", a.branch)], payload);
    },
  }),
};
