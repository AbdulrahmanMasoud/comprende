# Google Antigravity Support

Comprende natively supports **Google Antigravity** (both Antigravity IDE and Antigravity CLI).

---

## Architecture in Antigravity

Antigravity uses a unified bundle model for plugins, allowing skills, rules, MCP servers, and lifecycle hooks to be packaged together:

```text
comprende/
├── plugin.json         # Antigravity plugin manifest
├── mcp_config.json     # MCP server definition (runs dist/server.mjs)
├── hooks.json          # Lifecycle hooks (SessionStart, PreToolUse)
├── rules/
│   └── AGENTS.md       # Always-on guidelines (explanations, Arabic RTL & BiDi)
├── skills/
│   └── comprende/
│       ├── SKILL.md    # Detailed skill prompt & workflow
│       ├── references/ # Formats, signals, memory, and ownership check
│       └── scripts/    # Standalone bundled tools (gate.mjs, learning.mjs)
├── dist/
│   ├── server.mjs      # Bundled MCP server
│   ├── gate.mjs        # Bundled ownership gate CLI & hook handlers
│   └── learning.mjs    # Bundled standalone learning setup script
└── assets/
    └── icon.png        # Plugin logo
```

---

## Supported Capabilities

### 1. Explain As You Build (with Full Arabic & RTL Support)
* **Always-on Rules (`rules/AGENTS.md`)**: Antigravity loads these rules in every turn. It automatically calibrates explanations to be short (2–4 sentences), focused on non-obvious code, new APIs, or architectural decisions.
* **Arabic & BiDi Formatting**: When the user writes in Arabic or Egyptian Arabic, Antigravity responds natively in RTL. English technical terms, function names, and code identifiers are strictly wrapped in backticks (`` `code` ``) to prevent bidirectional punctuation flipping and disordered sentence display.
* **Auto-Calibration Keywords**:
  * "ليه؟" / "why?" $\rightarrow$ deeper explanation.
  * "عارف" / "I know" $\rightarrow$ reduces explanations for that topic and records familiarity in the learner profile.
  * "كمّل ساكت" / "just build" $\rightarrow$ silences explanations except for security or breaking risks.

### 2. Persistent Cross-Project Memory (MCP)
Comprende exposes its full suite of 9 MCP tools via `mcp_config.json`:
* `learning_context`: Calibrates at session start from `~/.comprende/profile.json` and project maps.
* `record_topic`: Tracks known vs learning topics across projects.
* `record_checkpoint`: Records quick comprehension checkpoint answers.
* `set_preference`: Saves explicit user preferences (e.g. language/dialect).
* `progress_report`: Returns a summary of learned topics and checkpoint accuracy.
* `search_decisions`, `add_decision`, `update_map`: Manages `.learning/` architecture records.
* `gate_status`, `save_check_report`: Manages ownership verification.

### 3. Lifecycle Hooks (`hooks.json`)
* **`SessionStart`**: Runs `gate.mjs antigravity-session-start`. Checks Node.js version, ensures the pre-push git hook is installed in gated repositories, and injects session reminders via Antigravity's `injectSteps` protocol.
* **`PreToolUse` (Matcher: `run_command`)**: Runs `gate.mjs antigravity-pre-tool-use`. Intercepts shell executions. If the command pushes code (e.g. `git push`, `gh pr create`) and the repository requires an ownership check, the hook verifies the branch:
  * If unverified or missing a report $\rightarrow$ returns `{ "decision": "deny", "reason": "Blocked by the ownership gate: ..." }`.
  * If verified and report committed $\rightarrow$ returns `{ "decision": "allow" }`.

---

## Installation

### From Source / Local Link
Symlink or copy the directory into Antigravity's plugin directory:

```bash
mkdir -p ~/.gemini/config/plugins
ln -s /path/to/comprende ~/.gemini/config/plugins/comprende
```

Verify that Antigravity discovers the plugin:
* Open Antigravity Customizations to see **comprende**.
* Or run `/mcp` to verify `comprende_comprende` tools are registered.

