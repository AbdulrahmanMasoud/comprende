# Comprende: the ownership gate in a terminal.
#
# Render it from the repository root with VHS (https://github.com/charmbracelet/vhs):
#   vhs docs/demo.tape
# That writes docs/demo.gif. test/consistency.test.mjs runs the same commands,
# so the demo can't drift from what the gate actually does.

Output docs/demo.gif

Require git
Require node

Set Shell "bash"
Set FontSize 15
Set Width 1280
Set Height 760
Set Padding 24
Set TypingSpeed 35ms

# Off camera: this checkout's gate, a scratch folder with a bare "GitHub" remote, a git identity.
Hide
Type `export GATE="$PWD/dist/gate.mjs" GIT_AUTHOR_NAME=Dev GIT_AUTHOR_EMAIL=dev@example.com GIT_COMMITTER_NAME=Dev GIT_COMMITTER_EMAIL=dev@example.com`
Enter
Type `cd "$(mktemp -d)" && git init -q --bare -b main origin.git && git init -q -b main app && cd app && git remote add origin ../origin.git`
Enter
Type `printf 'export const add = (a, b) => a + b;\n' > math.js && git add -A && git commit -qm init && git push -q -u origin main`
Enter
Ctrl+L
Show

Type "# 1. A repo whose main branch has the ownership gate"
Enter
Type `node "$GATE" install --repo . >/dev/null && git add -A && git commit -qm "add ownership gate" && git push -q origin main && ls .learning`
Enter
Sleep 2s

Type "# 2. Change some code and push it: blocked, nobody has checked it yet"
Enter
Type `git checkout -q -b feature/sum && printf 'export const sum = (xs) => xs.reduce(add, 0);\n' >> math.js && git commit -qam "add sum"`
Enter
Type `git push -u origin feature/sum`
Enter
Sleep 4s

Type "# 3. In Claude you say 'check me'. It asks, you answer, and it saves the report:"
Enter
Type `node .learning/gate.mjs status`
Enter
Sleep 3s
Type `node .learning/gate.mjs save <<< '{"summary": "Added sum(xs): it adds up a list with add, starting at 0, so an empty list gives 0.", "verified": {"math.js": ["reduce with a start value", "an empty list gives 0"]}}'`
Enter
Sleep 2s
Type `head -9 .learning/checks/feature%2Fsum.md`
Enter
Sleep 4s

Type "# 4. Commit the report with the code: the push goes through"
Enter
Type `git add -A && git commit -qm "ownership report" && git push -q -u origin feature/sum && echo "pushed: feature/sum"`
Enter
Sleep 4s
