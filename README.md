# Waypoint agent plugin

Connects a coding agent to [Waypoint](https://github.com/nldlabs/waypoint) and makes its
runs report themselves. Works with **Claude Code**, **GitHub Copilot** (VS Code and CLI)
and **Codex**.

It does two things:

1. **Configures the Waypoint MCP server** for your agent.
2. **Attaches telemetry automatically.** A hook intercepts `waypoint_start_run`,
   `waypoint_checkpoint_run` and `waypoint_complete_run` and fills in what the harness
   already knows — agent, model, host, branch, changed files, unpushed commits — so the
   model never has to report it by hand (and never gets it wrong). The dashboard shows
   it on every run.

The hook is plain Node (22+), has no dependencies, and never blocks a call: if anything
goes wrong it stays silent and the tool call proceeds unchanged.

## You need two things from the Waypoint dashboard

Open **Connect agent** in the sidebar and copy:

- the **MCP URL** (ends in `/mcp`)
- an **agent token** — press *Generate token*

The plugin never writes the token to a file.

## Claude Code — one command

Paste this in a terminal, replacing the two placeholders with the values from
*Connect agent* (the dashboard's own snippet already has the first line filled in):

```bash
claude mcp add --transport http --scope user waypoint <MCP_URL> --header "Authorization: Bearer <AGENT_TOKEN>" && claude plugin marketplace add nldlabs/waypoint-plugin && claude plugin install waypoint@waypoint --scope user
```

That adds the Waypoint MCP server to your user config and installs the plugin, which is
hooks-only: it attaches the telemetry to the three run tools of whatever `waypoint`
server is connected. Start a new session. Done.

Prefer the menu for the plugin half? In the desktop app, VS Code or CLI: `/plugin` →
**Marketplaces** → add `nldlabs/waypoint-plugin` → **Discover** → **Waypoint** →
**Install** (User scope). The MCP server half still needs the `claude mcp add` line —
this Claude Code build has no dialog for a plugin to ask for a URL and token.

Later: **Marketplaces** → *Update* picks up new plugin versions; `claude mcp remove
waypoint` / re-run the first line rotates the token.

> Claude Code only applies a hook's rewritten input alongside a permission decision, so
> the hook auto-allows these three Waypoint tools (they are the run's own bookkeeping).
> Set `WAYPOINT_HOOK_DECISION=ask` if you would rather keep the prompt.

## GitHub Copilot and Codex — one command

Run the installer **in the repository you are working on**, with the two values from
*Connect agent* as flags. It clones this plugin to `~/.waypoint-plugin`, writes the
hook configuration into the repo, and writes the MCP server into your user config —
nothing to edit by hand:

```bash
git clone -q --depth 1 https://github.com/nldlabs/waypoint-plugin "$HOME/.waypoint-plugin" 2>/dev/null; node "$HOME/.waypoint-plugin/scripts/install.js" codex copilot --url "<MCP_URL>" --token "<AGENT_TOKEN>"
```

PowerShell:

```bash
if (!(Test-Path "$HOME/.waypoint-plugin")) { git clone -q --depth 1 https://github.com/nldlabs/waypoint-plugin "$HOME/.waypoint-plugin" }; node "$HOME/.waypoint-plugin/scripts/install.js" codex copilot --url "<MCP_URL>" --token "<AGENT_TOKEN>"
```

Pick the targets you use: `codex` writes `~/.codex/config.toml` + `.codex/hooks.json`;
`copilot` writes `~/.copilot/mcp-config.json` + `.github/hooks/waypoint.json` (read by
Copilot CLI and the Copilot cloud agent); `vscode` writes `.vscode/mcp.json` (prompts
for the token in VS Code's own UI) + hooks in `.claude/settings.json`; `all` does
everything. Re-running merges rather than overwrites; `--dry-run` previews.

Prefer to keep the token out of user config files? Omit `--token` and the installer
prints the env-var snippets (`WAYPOINT_TOKEN`) to paste instead.

## Check it works

Start a run and open it in the dashboard: the run vitals show **Agent**
(`claude-code · claude-opus-5`, say) and **Host**. Or see exactly what the hook would
attach right now:

```bash
node scripts/waypoint-hook.js --event collect --harness claude-code
```

## What gets attached

| Field | Source | On |
| --- | --- | --- |
| `agent.harness`, `agent.model` | harness flag / hook payload / Claude transcript | all three |
| `agent.host`, `os`, `user`, `cwd`, `plugin` | the machine | all three |
| `branch`, `repositoryUrl` | git (only if the model left them blank) | `start_run` |
| `files`, `commits` | uncommitted changes + commits not yet pushed, merged with what the model listed (caps 200 / 100) | `checkpoint_run`, `complete_run` |

Fields the model supplies explicitly always win. The Waypoint server validates and
bounds `agent` like any other field.

## Layout

```
.claude-plugin/plugin.json        Claude Code plugin manifest (hooks-only)
.claude-plugin/marketplace.json   this repo is its own marketplace
hooks/hooks.json                  SessionStart + PreToolUse hooks (Claude Code)
scripts/waypoint-hook.js          the hook — one script for every harness
scripts/install.js                writes Codex / Copilot / VS Code config into a repo
templates/                        what install.js renders
test/                             node --test (no dependencies)
```

## Developing

```bash
node --test
claude plugin validate .
claude --plugin-dir .        # try the working copy for one session
```

Bump `version` in both `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json`
together (the tests check they match), push, and installed copies pick it up via
**Marketplaces → Update**.

MIT.
