# Antigravity hook payloads

Real hook input from Antigravity, captured on 2026-11-12 with the Antigravity CLI `agy` `1.5.5` on macOS, in headless mode (`agy -p … --output-format stream-json`), signed in with a Google account. They come from Step 0 ([recording](../../../docs/recordings/antigravity/)), where Comprende 0.4.2 ran as `agy plugin install` converts it. Each file is the JSON the plugin's hook read on stdin. `test/consistency.test.mjs` feeds them to the plugin's own hook commands in `hooks.json`.

Don't write these by hand. To change one, capture it again from a real run.

| File | The hook and the case |
|---|---|
| `session-start.json` | `SessionStart`, at the start of a headless session in the gated repo (step `2-gated-ls-allowed`) |
| `pre-tool-use.run-command.ls.json` | `PreToolUse` before the shell tool, `run_command`, runs `ls` (the same step) |
| `pre-tool-use.run-command.git-push.json` | `PreToolUse` before `git push origin feature/sum` (step `5-gated-push`) |

Things to know:

- The payloads are camelCase, with `cwd` and `hookEventName`, which Antigravity's docs don't list. `PreToolUse` adds `stepIdx` and `toolCall: {id, name, args}`, and the command is `toolCall.args.CommandLine`.
- `cwd` was the repo's root. The plugin's hooks ran in the plugin's own folder.
- `stepIdx` was 2 in both captures: it's the step's index in the conversation (step 0 is the prompt, step 1 the model's reply), so it repeats across conversations and isn't an id.

## How the captures were cleaned

The values below were replaced, the same way as in the recording. Nothing else was changed, apart from formatting with Biome.

- **The project path:** `/work/probe-app`, as in the other tools' fixtures (the recording has `/work/app`).
- **The home folder:** `/home/user`, in `artifactDirectoryPath` and `transcriptPath`.
- **IDs:** the conversation and tool-call ids became `00000000-0000-4000-8000-00000000000N`, numbered in the order they first appear in the recording. `toolCall.id` keeps its `call_` prefix.
