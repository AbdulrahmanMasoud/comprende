# Comprende: the ownership gate in a terminal.
#
# Render it from the repository root with VHS (https://github.com/charmbracelet/vhs):
#   vhs docs/demo.tape
# That writes docs/demo.gif. test/consistency.test.mjs runs the same commands,
# so the demo can't drift from what the gate actually does.

Output docs/demo.gif

Require git
Require node
Require fold

Set Shell "bash"
Set Theme "Catppuccin Mocha"
Set FontSize 22
Set Width 1320
Set Height 600
Set Padding 28
Set WindowBar Colorful
Set BorderRadius 10
Set Margin 20
Set MarginFill "#45475a"
Set TypingSpeed 30ms

# Off camera: a repo whose main branch has the gate, a bare "GitHub" remote, a
# branch with one new function, and the answers Claude would save after "check me".
Hide
Type `export GATE="$PWD/dist/gate.mjs" GIT_AUTHOR_NAME=Dev GIT_AUTHOR_EMAIL=dev@example.com GIT_COMMITTER_NAME=Dev GIT_COMMITTER_EMAIL=dev@example.com`
Enter
Type `cd "$(mktemp -d)" && git init -q --bare -b main origin.git && git init -q -b main app && cd app && git remote add origin ../origin.git && git config push.autoSetupRemote true`
Enter
Type `printf 'export const add = (a, b) => a + b;\n' > math.js && git add -A && git commit -qm init && node "$GATE" install --repo . >/dev/null && git add -A && git commit -qm "add ownership gate" && git push -q -u origin main`
Enter
Type `git checkout -q -b feature/sum && printf 'export const sum = (xs) => xs.reduce(add, 0);\n' >> math.js && git commit -qam "add sum"`
Enter
Type `printf '%s\n' '{"summary": "sum(xs) adds up a list with add, starting at 0, so an empty list gives 0.", "verified": {"math.js": ["reduce with a start value", "an empty list gives 0"]}}' > .learning/report.local.json`
Enter
# Wrap long output at word boundaries instead of mid-word. The text itself is unchanged.
Type `set -o pipefail; git() { command git "$@" 2>&1 | fold -s -w 82; }; node() { command node "$@" 2>&1 | fold -s -w 82; }`
Enter
Type `PS1='\[\e[1;35m\](feature/sum)\[\e[0m\] \[\e[1;32m\]$\[\e[0m\] '`
Enter
Ctrl+L
Show

Type "# 1. Push code nobody has checked yet"
Enter
Type "git push"
Enter
Sleep 4s
Ctrl+L

Type `# 2. Say "check me" in Claude and answer. Claude saves the report:`
Enter
Type "node .learning/gate.mjs save --input .learning/report.local.json"
Enter
Sleep 1.5s
Type "head -8 .learning/checks/feature%2Fsum.md"
Enter
Sleep 4s
Ctrl+L

Type "# 3. Commit the report with the code, then push"
Enter
Type `git add -A && git commit -qm "ownership report" && git push`
Enter
Sleep 4s
