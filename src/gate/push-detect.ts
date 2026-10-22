// Does a shell command push? A small shell tokenizer, so `git stash push` or a quoted
// "git push" in a commit message don't count, while `sudo git push` and `bash -c "git push"` do.

const WRAPPERS = new Set(["sudo", "doas", "env", "command", "builtin", "exec", "time", "nohup", "nice", "stdbuf"]);

const WRAPPER_ARG_OPTS = new Set(["-u", "-g", "-C", "-h", "-p", "-n", "-f", "-o", "-i", "-e"]);

const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh"]);

const GIT_ARG_OPTS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--config-env"]);

const GH_ARG_OPTS = new Set(["-R", "--repo", "--hostname"]);

const PUNCT = "();<>|&";

/** A small POSIX-style tokenizer: quotes and escapes respected, runs of
 *  `();<>|&` as their own tokens, `#` at a word start begins a comment.
 *  Returns null on an unterminated quote. */
function tokenize(command: string): string[] | null {
  const tokens: string[] = [];
  let cur = "";
  let inWord = false;
  let i = 0;
  const flush = () => {
    if (inWord) tokens.push(cur);
    cur = "";
    inWord = false;
  };
  while (i < command.length) {
    const c = command[i];
    if (c === " " || c === "\t" || c === "\r" || c === "\n") {
      flush();
      i++;
    } else if (PUNCT.includes(c)) {
      flush();
      let j = i;
      while (j < command.length && PUNCT.includes(command[j])) j++;
      tokens.push(command.slice(i, j));
      i = j;
    } else if (c === "#" && !inWord) {
      while (i < command.length && command[i] !== "\n") i++;
    } else if (c === "'") {
      const end = command.indexOf("'", i + 1);
      if (end < 0) return null;
      cur += command.slice(i + 1, end);
      inWord = true;
      i = end + 1;
    } else if (c === '"') {
      i++;
      inWord = true;
      for (;;) {
        if (i >= command.length) return null;
        const d = command[i];
        if (d === '"') {
          i++;
          break;
        }
        if (d === "\\" && i + 1 < command.length && '\\"$`\n'.includes(command[i + 1])) {
          cur += command[i + 1];
          i += 2;
        } else {
          cur += d;
          i++;
        }
      }
    } else if (c === "\\") {
      if (i + 1 < command.length) cur += command[i + 1];
      inWord = true;
      i += 2;
    } else {
      cur += c;
      inWord = true;
      i++;
    }
  }
  flush();
  return tokens;
}

function commandSegments(command: string): string[][] {
  command = command.replace(/\\\n/g, " ").replace(/\n/g, ";");
  const tokens = tokenize(command) ?? command.split(/\s+/).filter(Boolean);
  const segs: string[][] = [];
  let seg: string[] = [];
  for (const tok of tokens) {
    if (tok && [...tok].every((c) => ";&|()".includes(c))) {
      segs.push(seg);
      seg = [];
    } else seg.push(tok);
  }
  segs.push(seg);
  return segs.filter((s) => s.length);
}

/** "git" for "/usr/bin/git": the program a token names. */
const programName = (t: string) => t.split("/").pop() ?? t;

/** True if a shell command runs `git push` or `gh pr create/merge`. Tokenises
 *  like a shell (quotes respected), so `git stash push` or
 *  `git commit -m "then git push"` don't count, while `git -C repo push`,
 *  `sudo git push`, `bash -c "git push"` and `(git push)` do. */
export function isPushCommand(command: string, depth = 0): boolean {
  if (depth > 3) return false;
  for (let tokens of commandSegments(command)) {
    let i = 0;
    while (i < tokens.length) {
      const tok = tokens[i];
      if (["{", "}", "!"].includes(tok) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(tok)) i++;
      else if (WRAPPERS.has(programName(tok))) {
        i++;
        while (i < tokens.length && tokens[i].startsWith("-")) i += WRAPPER_ARG_OPTS.has(tokens[i]) ? 2 : 1;
      } else break;
    }
    tokens = tokens.slice(i);
    if (!tokens.length) continue;
    const prog = programName(tokens[0]);
    if (SHELLS.has(prog)) {
      for (let j = 1; j < tokens.length - 1; j++) {
        const t = tokens[j];
        if (t.startsWith("-") && !t.startsWith("--") && t.slice(1).includes("c")) {
          if (isPushCommand(tokens[j + 1], depth + 1)) return true;
          break;
        }
      }
    } else if (prog === "git") {
      let j = 1;
      while (j < tokens.length && tokens[j].startsWith("-")) j += GIT_ARG_OPTS.has(tokens[j]) ? 2 : 1;
      if (j < tokens.length && tokens[j] === "push") return true;
    } else if (prog === "gh") {
      let j = 1;
      while (j < tokens.length && tokens[j].startsWith("-")) j += GH_ARG_OPTS.has(tokens[j]) ? 2 : 1;
      if (tokens[j] === "pr" && j + 1 < tokens.length && ["create", "merge"].includes(tokens[j + 1])) return true;
    }
  }
  return false;
}
