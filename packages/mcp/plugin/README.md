# sandbank plugin

Connects Claude Code and Codex to the Sandbank MCP server
(`@sandbank.dev/mcp`, stdio): create sandboxes on local Docker or the sbx
cloud, run commands, move files, expose ports, and show an inline console.

Contents:

- `.claude-plugin/plugin.json`, `.mcp.json`: Claude Code manifest and MCP
  config (launches `npx -y @sandbank.dev/mcp`, passes `SBX_API_KEY` through).
- `skills/sandbank/SKILL.md`: the usage skill, loaded automatically with the
  plugin.

## Requirements

- Node 20+ for `npx`.
- Docker provider: the `docker` CLI and a reachable daemon.
- sbx provider: export `SBX_API_KEY` (create one at
  <https://sbx.agent-next.com/console>) in the environment that launches the
  agent. Without it only the docker provider is configured.

## Claude Code

Install the plugin directory, or add the server directly:

```bash
claude mcp add sandbank -e SBX_API_KEY="$SBX_API_KEY" -- npx -y @sandbank.dev/mcp
```

## Codex

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.sandbank]
command = "npx"
args = ["-y", "@sandbank.dev/mcp"]
env_vars = ["SBX_API_KEY"]
```

`env_vars` forwards the variable from your shell; do not write the key into
the file. Copy `skills/sandbank/SKILL.md` to `~/.codex/skills/sandbank/SKILL.md`.
