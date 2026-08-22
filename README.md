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

## Claude Code — install from the menu

In Claude Code (desktop app, VS Code extension or CLI), everything happens in the
prompt box:

1. Type `/plugin` and press Enter.
2. **Marketplaces** → **Add marketplace** → enter `nldlabs/Waypoint-Plugin`.
3. **Discover** → **Waypoint** → **Install** → choose the **User** scope.
4. A dialog asks for the **MCP URL** and **agent token** — paste them.
5. Start a new session. Done.

Later: `/plugin` → **Installed** → Waypoint → *Configure* to change the URL or token;
**Marketplaces** → *Update* to get a newer version.

Terminal equivalent:

```bash
claude plugin marketplace add nldlabs/Waypoint-Plugin
claude plugin install waypoint@waypoint --scope user
```

> Claude Code only applies a hook's rewritten input alongside a permission decision, so
> the hook auto-allows these three Waypoint tools (they are the run's own bookkeeping).
> Set `WAYPOINT_HOOK_DECISION=ask` if you would rather keep the prompt.

## GitHub Copilot and Codex

These read the URL and token from your shell:

```bash
export WAYPOINT_MCP_URL="https://…/mcp"
export WAYPOINT_TOKEN="<agent token>"
```

(PowerShell: `$env:WAYPOINT_MCP_URL = "…"; $env:WAYPOINT_TOKEN = "…"`.)

Then, from a checkout of this repo, run the installer **in the repository you are
working on** — it writes the hook configuration there and prints the one snippet you
need to add to your user config:

| Agent | Command | Writes | You add |
| --- | --- | --- | --- |
| VS Code (Copilot agent mode) | `node <plugin>/scripts/install.js vscode --url $WAYPOINT_MCP_URL` | `.vscode/mcp.json` (prompts for the token on first start), hooks in `.claude/settings.json` | nothing — start the server from the MCP view |
| Copilot CLI / cloud agent | `node <plugin>/scripts/install.js copilot --url $WAYPOINT_MCP_URL` | `.github/hooks/waypoint.json` | the printed server block to `~/.copilot/mcp-config.json` |
| Codex | `node <plugin>/scripts/install.js codex --url $WAYPOINT_MCP_URL` | `.codex/hooks.json` | the printed `[mcp_servers.waypoint]` block to `~/.codex/config.toml` |

`all` does every one; re-running merges rather than overwrites; `--dry-run` previews.

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
.claude-plugin/plugin.json        Claude Code plugin manifest (asks for URL + token at install)
.claude-plugin/marketplace.json   this repo is its own marketplace
.mcp.json                         the Waypoint MCP server
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
