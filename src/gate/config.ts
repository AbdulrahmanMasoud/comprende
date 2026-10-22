// .learning/config.json: defaults, strict validation, and where the rules come from
// (the base branch, so a PR can't loosen its own check).
import { join } from "node:path";
import { lstat, MAX_CONFIG_BYTES, readSmall } from "./files.js";
import { hasFile, showSmall } from "./git.js";
import { globMatch, matches } from "./glob.js";
import { CONFIG_PATH, GateError, isObj } from "./shared.js";

type Mode = "required" | "suggested" | "off";

export interface Config {
  mode: Mode;
  base: string;
  sensitive: string[];
  ignore: string[];
  min_summary_chars: number;
  small_change_lines: number;
  small_summary_chars: number;
  skip_label: string;
  _configured: boolean;
}

export const DEFAULT_CONFIG: Omit<Config, "_configured"> = {
  mode: "required", // required | suggested | off
  base: "", // empty = auto-detect (upstream/, origin/HEAD, main, master)
  sensitive: ["**/auth/**", "**/payments/**", "**/migrations/**", "**/security/**"],
  // "ignore" = no questions asked. Ignored files are still tracked: changing
  // them after a report makes it stale, like any other file.
  ignore: ["**/package-lock.json", "**/yarn.lock", "**/pnpm-lock.yaml", "**/poetry.lock", "**/Cargo.lock", "**/go.sum"],
  min_summary_chars: 80,
  // A change with at most this many added + removed lines (ignored files not
  // counted; nothing sensitive, binary or a submodule) needs only a summary of
  // small_summary_chars. 0 turns the fast path off.
  small_change_lines: 10,
  small_summary_chars: 30,
  skip_label: "skip-ownership-check",
};

/** The source text of the value at `path` in `raw` (valid JSON), or null if
 *  absent. A later duplicate key replaces an earlier one, as in JSON.parse.
 *  Lets the config tell `80.0` from `80`, which JSON.parse can't. */
function valueSource(raw: string, path: string[]): string | null {
  let i = 0;
  let found: string | null = null;
  const ws = () => {
    while (" \t\n\r".includes(raw[i]) && i < raw.length) i++;
  };
  const str = (): string => {
    const start = i++;
    while (raw[i] !== '"') i += raw[i] === "\\" ? 2 : 1;
    return JSON.parse(raw.slice(start, ++i)) as string;
  };
  // Skip one value without recursion, so deep nesting can't overflow the stack.
  const skip = () => {
    if (raw[i] === '"') return void str();
    if (raw[i] !== "{" && raw[i] !== "[") {
      while (i < raw.length && !",]} \t\n\r".includes(raw[i])) i++;
      return;
    }
    let depth = 0;
    do {
      if (raw[i] === '"') {
        str();
        continue;
      }
      if (raw[i] === "{" || raw[i] === "[") depth++;
      else if (raw[i] === "}" || raw[i] === "]") depth--;
      i++;
    } while (depth > 0);
  };
  const walk = (depth: number): void => {
    i++; // {
    ws();
    if (raw[i] === "}") return void i++;
    for (;;) {
      ws();
      const key = str();
      ws();
      i++; // :
      ws();
      if (key !== path[depth]) skip();
      else if (depth === path.length - 1) {
        const start = i;
        skip();
        found = raw.slice(start, i);
      } else {
        found = null;
        if (raw[i] === "{") walk(depth + 1);
        else skip();
      }
      ws();
      if (raw[i++] === "}") return;
    }
  };
  ws();
  if (raw[i] === "{") walk(0);
  return found;
}

function parseConfig(raw: string, where: string): Config {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    throw new GateError(`${where}: not valid JSON (${(e as Error).message}).`);
  }
  const section = isObj(data)
    ? isObj(data.ownership_check)
      ? data.ownership_check
      : "ownership_check" in data
        ? data.ownership_check
        : data
    : null;
  if (!isObj(section)) throw new GateError(`${where}: expected an object like {"ownership_check": {...}}.`);
  const cfg = { ...DEFAULT_CONFIG, ...section } as Record<string, unknown>;
  // Strict types: a string where a list belongs would be read character by
  // character, and "*" alone matches every path — silently disabling the gate.
  if (!["required", "suggested", "off"].includes(cfg.mode as string))
    throw new GateError(`${where}: mode must be required, suggested or off.`);
  for (const key of ["sensitive", "ignore"]) {
    const v = cfg[key];
    if (!Array.isArray(v) || !v.every((x) => typeof x === "string" && x))
      throw new GateError(`${where}: "${key}" must be a list of glob strings.`);
    for (const pat of v as string[]) {
      try {
        globMatch("", pat);
      } catch {
        throw new GateError(`${where}: "${key}" has a pattern that can't be used: ${JSON.stringify(pat)}.`);
      }
    }
  }
  for (const key of ["base", "skip_label"]) {
    if (typeof cfg[key] !== "string") throw new GateError(`${where}: "${key}" must be a string.`);
  }
  for (const key of ["min_summary_chars", "small_change_lines", "small_summary_chars"]) {
    const m = cfg[key];
    const literal = valueSource(raw, section === data ? [key] : ["ownership_check", key]);
    const floatLiteral = literal !== null && /[.eE]/.test(literal);
    if (typeof m !== "number" || !Number.isInteger(m) || m < 0 || floatLiteral)
      throw new GateError(`${where}: "${key}" must be a non-negative integer.`);
  }
  return { ...(cfg as unknown as Config), _configured: true };
}

const suggestedDefaults = (): Config => ({ ...DEFAULT_CONFIG, mode: "suggested", _configured: false });

/** Config from a commit or from the working tree. With none, the gate is
 *  'suggested' (nobody opted this repo in). */
export function loadConfig(root: string, rev?: string | null): Config {
  if (rev) {
    if (!hasFile(root, rev, CONFIG_PATH)) return suggestedDefaults();
    return parseConfig(showSmall(root, rev, CONFIG_PATH, MAX_CONFIG_BYTES), `${CONFIG_PATH} at ${rev}`);
  }
  const path = join(root, CONFIG_PATH);
  if (!lstat(path)) return suggestedDefaults();
  return parseConfig(readSmall(path, MAX_CONFIG_BYTES), CONFIG_PATH);
}

/** CI and hooks judge a change by the rules on the *base* branch. If the base
 *  has no config, the strict defaults apply — never the PR's own config,
 *  which the PR could have written to switch itself off. */
export function rulesForVerify(root: string, baseRef: string): Config {
  if (hasFile(root, baseRef, CONFIG_PATH))
    return parseConfig(showSmall(root, baseRef, CONFIG_PATH, MAX_CONFIG_BYTES), `${CONFIG_PATH} on ${baseRef}`);
  return { ...DEFAULT_CONFIG, _configured: false };
}

/** status/save use the rules CI will apply (the base's), so what passes
 *  locally passes in CI. Before the base has a config, fall back to the
 *  working tree's config, or 'suggested'. */
export function rulesForLocal(root: string, baseRef: string): Config {
  if (hasFile(root, baseRef, CONFIG_PATH)) return rulesForVerify(root, baseRef);
  return loadConfig(root);
}

/** Submodule bumps can pull in any amount of code, so they're always
 *  sensitive. A gitlink or symlink at 'vendor/payments' is matched as if it
 *  were the folder, so '**\/payments/**' covers it. */
export function isSensitive(path: string, mode: string, cfg: Pick<Config, "sensitive">): boolean {
  if (mode === "160000") return true;
  return matches(path, cfg.sensitive) || matches(`${path}/_`, cfg.sensitive);
}

/** Ignored files don't need questions — unless they're also sensitive. */
export const noQuestions = (path: string, mode: string, cfg: Config) =>
  matches(path, cfg.ignore) && !isSensitive(path, mode, cfg);
