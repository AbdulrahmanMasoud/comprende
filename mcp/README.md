# explain-as-you-build MCP server

The memory and ownership-gate tools for the **explain-as-you-build** Claude Code plugin. The plugin starts this server for you, so you don't need to install it by hand. See the [main README](../README.md).

## Develop

```bash
cd mcp
pip install -e ".[test]" pyyaml
PYTHONPATH=src:tests pytest -q
```

- `src/explain_mcp/gate.py`: the ownership gate, in one stdlib-only file. It is copied into each repo as `.learning/gate.py` and ships with the plugin as `skills/explain-as-you-build/scripts/gate.py`. Those two copies must stay identical; a test enforces this.
- `src/explain_mcp/store.py`: the learner profile, project map and decision records.
- `src/explain_mcp/server.py`: the MCP tool layer. It runs the repo's own `.learning/gate.py` when one exists.
