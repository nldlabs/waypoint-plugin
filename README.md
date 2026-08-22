# Waypoint agent plugin

One directory that connects a coding agent to Waypoint and makes its runs report
themselves. It does two things:

1. **Configures the Waypoint MCP server** for the harness you use — Claude Code,
   GitHub Copilot (VS Code or CLI), or Codex — without hand-editing JSON.
2. **Attaches telemetry deterministically.** A `PreToolUse` hook intercepts
   `waypoint_start_run`, `waypoint_checkpoint_run` and `waypoint_complete_run` and
   rewrites the call so it carries what the harness already knows and the model
   would otherwise have to type (and get wrong, or forget):

   | Field | Source | On |
   | --- | --- | --- |
   | `agent.harness` | the hook's `--harness` flag, else env detection | all three |
   | `agent.model` | Codex/VS Code payload `model`; Claude transcript (last assistant message) or SessionStart cache; `WAYPOINT_AGENT_MODEL` override | all three |
   | `agent.host`, `agent.os`, `agent.user`, `agent.cwd` | `os.hostname()`, platform + release, `os.userInfo()`, hook `cwd` | all three |
   | `agent.plugin` | `waypoint-plugin/<version>` from `.claude-plugin/plugin.json` | all three |
   | `branch`, `repositoryUrl` | `git rev-parse --abbrev-ref HEAD`, `git remote get-url origin` — only if the model left them blank | `start_run` |
   | `files` | uncommitted changes (`git status --porcelain -uall`) ∪ files in commits not yet on the upstream/default branch, unioned with whatever the model listed, capped at 200 | `checkpoint_run`, `complete_run` |
   | `commits` | `git log @{upstream}..HEAD` (fallback `origin/main`/`main`), unioned, capped at 100 | `checkpoint_run`, `complete_run` |

   The dashboard shows `agent` in the run vitals (harness · model, host), the run
   handoff carries it, and every checkpoint event records the telemetry as of that
   moment. Fields the model supplies explicitly win over detected ones.

   Without the hook, Waypoint still guesses the harness from what the MCP client
   said about itself on `initialize` (remembered per agent token) and marks it
   `source: "detected"`. The hook's record supersedes that guess at the next
   start/checkpoint/complete, and the marker is dropped. Each run also records
   which agent token started it, so the dashboard can name the operator's token.

The hook is plain Node (22+), has no dependencies, and **never blocks a call**: on
any failure it prints nothing and exits 0, so the tool call proceeds unmodified.

## Layout

```
plugin/
├── .claude-plugin/plugin.json   Claude Code plugin manifest
├── .mcp.json                    Claude Code MCP server (reads $WAYPOINT_MCP_URL, $WAYPOINT_TOKEN)
├── hooks/hooks.json             Claude Code hooks (SessionStart + PreToolUse on the three run tools)
├── scripts/waypoint-hook.js     The hook — one script for every harness
├── scripts/install.js           Writes Codex / Copilot / VS Code config into a repo
└── templates/                   What install.js renders (also usable by hand)
```

## Before you start

You need two values from the Waypoint dashboard — **Connect agent** in the sidebar:

- the MCP URL, e.g. `https://api.waypoint.example.com/mcp` (local: `http://localhost:4566/.../mcp`)
- an **agent token** — press **Generate token** and copy it (deployed stacks only;
  LocalStack needs none)

Claude Code asks for both in a dialog (next section). The other harnesses read
them from your shell — the plugin never writes the token to disk:

```bash
export WAYPOINT_MCP_URL="https://api.waypoint.example.com/mcp"
export WAYPOINT_TOKEN="<agent token>"
```

(PowerShell: `$env:WAYPOINT_MCP_URL = "…"; $env:WAYPOINT_TOKEN = "…"`; add them to
your profile to persist.)

## Claude Code — install from the menu, no terminal

This plugin is distributed as its own repository, and that repository is also a
Claude Code **plugin marketplace** (`.claude-plugin/marketplace.json` publishes the
plugin at `./`). In Claude Code — the desktop app, the VS Code extension, or the
CLI — everything happens in the prompt box:

1. Type `/plugin` and press Enter. The plugin manager opens.
2. Go to the **Marketplaces** tab → **Add marketplace** and enter one of:
   - `nldlabs/waypoint-plugin` — the plugin's GitHub repository (private is fine:
     Claude Code clones it with your own git credentials, or `GITHUB_TOKEN`; use the
     SSH form `git@github.com:nldlabs/waypoint-plugin.git` if that is how you
     authenticate)
   - a local path to a checkout of the plugin, such as `D:/waypoint-plugin` or
     `/Users/you/waypoint-plugin` (inside the product monorepo: `D:/Waypoint/plugin`)
3. Go to the **Discover** tab, choose **Waypoint**, press **Install**, and pick the
   **user** scope so it is on in every project.
4. A configuration dialog asks for the **Waypoint MCP URL** and the **Waypoint
   agent token** — paste the two values from *Connect agent*. The token field is
   masked and lands in your OS secure storage, not in a file.
5. Start a new session. Done: the `waypoint` tools are available
   (`mcp__plugin_waypoint_waypoint__*`), a SessionStart note tells the model that
   telemetry is automatic, and the PreToolUse hook attaches it on the three run tools.

To change the URL or token later: `/plugin` → **Installed** → Waypoint → *Configure*.
To pick up a newer version of the plugin: **Marketplaces** → Waypoint → *Update*.

Terminal equivalent, if you prefer it:

```bash
claude plugin marketplace add nldlabs/waypoint-plugin      # or a local path
claude plugin install waypoint@waypoint --scope user
```

Trying it for a single session from a checkout, without a marketplace:

```bash
claude --plugin-dir .            # from the plugin repo; ./plugin from the monorepo
```

(With `--plugin-dir` there is no install dialog, so Claude Code prompts for the two
values when the server first starts — or set them with
`claude plugin config waypoint` — because the plugin's `.mcp.json` reads
`${user_config.mcp_url}` and `${user_config.token}`.)

**Permission note.** Claude Code only applies a hook's `updatedInput` when the hook
also returns a permission decision, so the hook answers `allow` for these three
tools — they are the run's own bookkeeping and never destructive. If you would
rather keep the prompt, set `WAYPOINT_HOOK_DECISION=ask`.

Already added the server with `claude mcp add`? The hook matcher also covers
`mcp__waypoint__*`, so the plugin's hooks work with a hand-added server too; run
`node plugin/scripts/install.js vscode` to put the same hooks in
`.claude/settings.json` instead of installing the plugin.

## GitHub Copilot

### VS Code (agent mode)

```bash
node plugin/scripts/install.js vscode --url "$WAYPOINT_MCP_URL"
```

Writes (or merges into) two workspace files:

- `.vscode/mcp.json` — the `waypoint` HTTP server with a password-type `inputs`
  prompt for the token, so nothing secret lands in the file. VS Code asks for the
  token the first time the server starts and stores it in its secret storage.
- `.claude/settings.json` — the hooks, in the Claude format VS Code reads natively.
  The hook auto-detects VS Code (`copilot-vscode`).

Then **Start** the server from the MCP view (or accept the prompt VS Code shows
when it notices `mcp.json`).

### Copilot CLI and the Copilot cloud agent

```bash
node plugin/scripts/install.js copilot --url "$WAYPOINT_MCP_URL"
```

Writes `.github/hooks/waypoint.json` (Copilot's `version: 1` hook format, with
`bash` and `powershell` commands) — that file is read by Copilot CLI and by the
cloud agent from the repository's default branch. The hook recognises Copilot's
`toolName`/`toolArgs` payload and answers with `modifiedArgs`.

The MCP server goes in your user config, `~/.copilot/mcp-config.json`; the installer
prints the snippet:

```json
{
  "mcpServers": {
    "waypoint": {
      "type": "http",
      "url": "https://api.waypoint.example.com/mcp",
      "headers": { "Authorization": "Bearer ${WAYPOINT_TOKEN}" },
      "tools": ["*"]
    }
  }
}
```

## Codex (CLI and IDE extension)

```bash
node plugin/scripts/install.js codex --url "$WAYPOINT_MCP_URL"
```

Writes `.codex/hooks.json` in the repo (Codex uses the same `hooks` /
`matcher` / `hookSpecificOutput.updatedInput` contract as Claude Code; the command
carries the absolute path to the hook). Then add the server to
`~/.codex/config.toml` — the installer prints this:

```toml
[mcp_servers.waypoint]
url = "https://api.waypoint.example.com/mcp"
bearer_token_env_var = "WAYPOINT_TOKEN"
```

Codex's hook payload includes `model`, so the model is always filled in. Hooks
are enabled by default in current Codex; if yours are off, add
`[features] hooks = true` to `config.toml`.

## Everything at once

```bash
node plugin/scripts/install.js all --url "$WAYPOINT_MCP_URL"
```

Re-running is safe: JSON files are merged (our hook entries are replaced, yours
kept), other files are skipped unless you pass `--force`. `--dry-run` shows the
plan. `--token-env NAME` if your token lives in a differently named variable.

## Verifying it works

Start a run from the agent and open it in the dashboard: the vitals should show an
**Agent** entry (`claude-code · claude-opus-5`, say) and a **Host**. Or, from the
shell, see exactly what the hook would attach right now:

```bash
node plugin/scripts/waypoint-hook.js --event collect --harness claude-code
```

To exercise the rewrite by hand, pipe a payload in:

```bash
echo '{"hook_event_name":"PreToolUse","tool_name":"mcp__waypoint__waypoint_checkpoint_run","tool_input":{"projectId":"p","runId":"r"},"cwd":"'"$PWD"'"}' \
  | node plugin/scripts/waypoint-hook.js --harness claude-code
```

## Publishing (maintainers)

The plugin is developed inside the Waypoint monorepo under `plugin/` and shipped as
its own repository — users receive the plugin, not the product source. Publish the
directory's history with a subtree split and push it to the plugin repo:

```bash
git subtree split --prefix plugin -b plugin-release
git push git@github.com:nldlabs/waypoint-plugin.git plugin-release:main
git branch -D plugin-release
```

Bump `version` in both `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json`
before publishing (the test suite checks they match); installed copies pick the new
version up via `/plugin` → Marketplaces → *Update*.

## Design notes

- **Why a hook and not instructions.** Telling the model to report its harness
  costs tokens on every call and is still unreliable — it cannot see its own model
  name or hostname. The hook is free at inference time and exact.
- **Why `files` are unioned, not replaced.** The model sometimes names files that
  git does not see yet (planned edits, generated paths); git sometimes sees files
  the model forgot. The run keeps both. Each checkpoint carries the full current
  set, which is what the run's `files` field means.
- **Why the server validates `agent` like any other field.** The hook is
  convenience, not trust: the Lambda trims, bounds and drops unknown keys, so a
  hand-written or malicious `agent` object cannot bloat a run.
- **Nothing secret on disk.** Every generated file references an environment
  variable or a prompted input; `install.js` has a test asserting no bearer token
  ever appears in its output.
