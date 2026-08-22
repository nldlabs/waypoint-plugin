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

## Waiting for decisions

When an agent raises a **blocking** decision (`waypoint_raise_decision`,
`waypoint_propose_plan`) and calls `waypoint_await_decision`, the hook does the waiting:
it holds the tool call and polls Waypoint itself — every 10 s at first, backing off to
every 2 min — until you answer on the dashboard. The agent spends no tokens meanwhile and
continues in the same turn with your answer in hand. Each poll is also a heartbeat: if the
agent is stopped, killed or falls asleep, the polls stop and **Waypoint abandons the wait
itself** within about 6 minutes (the decision is closed with a note, the run released).
Nothing here tries to stop you stopping the agent.

- Works in Claude Code, Codex and Copilot (CLI and VS Code) with the hooks above; the hook
  reads the MCP URL and token from `WAYPOINT_MCP_URL` / `WAYPOINT_TOKEN`, else from the
  harness's own MCP config (`~/.claude.json`, `~/.codex/config.toml`,
  `~/.copilot/mcp-config.json` — both the native `url = "..."` server and the `npx mcp-remote <url> --header Authorization:${VAR}` form with `[mcp_servers.waypoint.env]`). VS Code's `.vscode/mcp.json` keeps the token as a secret
  input the hook cannot read — export the two env vars there.
- One hook invocation waits at most `WAYPOINT_WAIT_CHUNK_SECONDS` (default 1500) before
  handing back to the model with "call await again"; total wait is capped by
  `WAYPOINT_WAIT_MAX_SECONDS` (default 21600). Hook timeouts in the templates are 1800 s.
- State is per session and per decision under the OS temp dir, so several agents on one
  machine never share a wait. `WAYPOINT_WAIT_DISABLE=1` turns the feature off.

## Waiting for work

An agent with nothing to do can park itself in Waypoint's **agent queue** by calling
`waypoint_await_work`. The hook joins on its behalf — attaching harness, model, host, the
working directory and the git repositories it can reach (the one it is in, plus siblings
and children, with remote and branch) — and then polls exactly like the decision wait
until you **send it a message from the dashboard** (Waiting for work panel). The agent
resumes in the same turn with your instructions and is told to act on them, then to call
`waypoint_await_work` again with `after=<message id>` to rejoin the queue. An agent whose
polls stop drops off the panel within about 6 minutes.

Same knobs as the decision wait: `WAYPOINT_WAIT_CHUNK_SECONDS`, `WAYPOINT_WAIT_MAX_SECONDS`,
`WAYPOINT_WAIT_DISABLE=1` (the workspace is still attached; nothing is polled). State is
one file per session under the OS temp dir, so a chunked wait keeps its place in the queue.

## Layout

```
.claude-plugin/plugin.json        Claude Code plugin manifest (hooks-only)
.claude-plugin/marketplace.json   this repo is its own marketplace
hooks/hooks.json                  SessionStart + PreToolUse + PostToolUse hooks (Claude Code)
scripts/waypoint-hook.js          the hook — one entry point for every harness
scripts/decision-wait.js          suspends the agent until a blocking decision is answered
scripts/work-wait.js              parks an idle agent in the queue until the operator sends it work
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
