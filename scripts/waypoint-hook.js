#!/usr/bin/env node
'use strict';
/**
 * Waypoint agent hook — one script for every harness.
 *
 * Runs as a PreToolUse hook in Claude Code, Codex, VS Code Copilot and Copilot
 * CLI. When the tool being called is waypoint_start_run, waypoint_checkpoint_run
 * or waypoint_complete_run it rewrites the tool input so that the call carries
 * what the harness already knows and the model would otherwise have to type:
 *
 *   agent.harness / model / host / os / user / cwd / plugin   (telemetry)
 *   branch, repositoryUrl                                     (start_run, if absent)
 *   files, commits                                            (checkpoint/complete: git-derived, unioned)
 *   commands, checks                                          (checkpoint/complete: shell commands the agent ran since
 *                                                              the last checkpoint, recorded by PostToolUse on the shell
 *                                                              tool, with exit codes; see command-log.js)
 *
 * Zero dependencies, never fails the call: on any error it prints nothing and
 * exits 0, so the tool call proceeds unmodified.
 *
 * Invocation:
 *   node waypoint-hook.js [--harness <name>] [--event pretooluse|posttooluse|sessionstart|collect]
 *
 * PreToolUse on waypoint_await_decision and PostToolUse on waypoint_raise_decision /
 * waypoint_propose_plan suspend the agent until the operator answers (see decision-wait.js).
 * PreToolUse on waypoint_await_work attaches the workspace and the repositories in reach;
 * PostToolUse on it polls with the returned waiterId and suspends the agent until the
 * operator sends it a command (see work-wait.js).
 *
 * Input formats recognised on stdin:
 *   Claude Code / Codex / VS Code: { hook_event_name, tool_name, tool_input, cwd, model?, transcript_path?, session_id? }
 *   Copilot CLI:                   { toolName, toolArgs, cwd, sessionId }
 *
 * Output:
 *   Claude/Codex/VS Code: { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision, updatedInput } }
 *   Copilot CLI:          { modifiedArgs }
 *   SessionStart:         { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext } }
 *   --event collect:      the telemetry object alone (for debugging and for harnesses without input rewriting)
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const decisionWait = require('./decision-wait');
const workWait = require('./work-wait');
const commandLog = require('./command-log');

const TOOL_SUFFIXES = ['waypoint_start_run', 'waypoint_checkpoint_run', 'waypoint_complete_run'];
const FILE_CAP = 200;
const COMMIT_CAP = 100;
const GIT_TIMEOUT_MS = 4000;

function readPluginVersion() {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '.claude-plugin', 'plugin.json'), 'utf8'));
    return manifest.version ? `waypoint-plugin/${manifest.version}` : 'waypoint-plugin';
  } catch {
    return 'waypoint-plugin';
  }
}

function parseArgs(argv) {
  const args = { harness: undefined, event: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--harness') args.harness = argv[++i];
    else if (argv[i] === '--event') args.event = String(argv[++i] || '').toLowerCase();
  }
  return args;
}

function readStdin() {
  try {
    const text = fs.readFileSync(0, 'utf8');
    return text.trim() ? JSON.parse(text) : {};
  } catch {
    return {};
  }
}

function git(cwd, argv) {
  try {
    return execFileSync('git', argv, {
      cwd,
      encoding: 'utf8',
      timeout: GIT_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    }).trim();
  } catch {
    return undefined;
  }
}

/**
 * Which harness is running us. The payload is the most reliable witness: Codex stamps
 * every turn-scoped hook payload with `turn_id` and Claude Code never does. Environment
 * comes second and is deliberately narrow — Codex loads Claude-format plugins and sets
 * CLAUDE_PLUGIN_ROOT as a compatibility alias, and a harness launched from another
 * harness's terminal inherits its variables (WP-0720).
 */
function detectHarness(payload, env) {
  if (env.WAYPOINT_HARNESS) return env.WAYPOINT_HARNESS;
  if (payload && payload.toolName !== undefined && payload.tool_name === undefined) return 'copilot-cli';
  if (payload && payload.turn_id !== undefined) return 'codex';
  if (env.CLAUDECODE || env.CLAUDE_PROJECT_DIR || env.CLAUDE_CODE_ENTRYPOINT) return 'claude-code';
  if (env.CODEX_HOME || env.CODEX_SANDBOX || env.CODEX_THREAD_ID) return 'codex';
  if (env.CLAUDE_PLUGIN_ROOT && !env.PLUGIN_ROOT) return 'claude-code';
  if (env.COPILOT_CLI || env.COPILOT_AGENT || env.GITHUB_COPILOT_CLI) return 'copilot-cli';
  if (env.VSCODE_PID || env.TERM_PROGRAM === 'vscode') return 'copilot-vscode';
  return 'unknown';
}

// Claude Code does not put the model on PreToolUse input, but every assistant
// message in the transcript names it; the newest one wins. Bounded read so a
// long session costs nothing noticeable.
function modelFromTranscript(transcriptPath) {
  if (!transcriptPath) return undefined;
  try {
    const stat = fs.statSync(transcriptPath);
    const size = stat.size;
    const window = Math.min(size, 512 * 1024);
    const fd = fs.openSync(transcriptPath, 'r');
    const buffer = Buffer.alloc(window);
    fs.readSync(fd, buffer, 0, window, size - window);
    fs.closeSync(fd);
    const text = buffer.toString('utf8');
    const matches = text.match(/"model"\s*:\s*"([^"]+)"/g);
    if (!matches) return undefined;
    const last = matches[matches.length - 1].match(/"model"\s*:\s*"([^"]+)"/);
    const model = last && last[1];
    return model && model !== '<synthetic>' ? model : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Run once per tool call even when two hook sources fire us (WP-0720): Codex loads every
 * matching hook — a user's ~/.codex/hooks.json *and* a marketplace-installed plugin's
 * hooks/hooks.json — so without this the telemetry is attached twice and, worse, two
 * queue pollers run for one waiterId. First process to create the marker wins; a payload
 * without a tool_use_id (older harnesses) is never deduplicated.
 */
function claimOnce(payload, event) {
  const id = payload && (payload.tool_use_id || payload.toolUseId);
  const session = payload && (payload.session_id || payload.sessionId);
  if (!id || !session) return true;
  const dir = path.join(os.tmpdir(), 'waypoint-hook', 'once');
  const file = path.join(dir, `${String(session).replace(/[^A-Za-z0-9_.-]/g, '_')}-${String(id).replace(/[^A-Za-z0-9_.-]/g, '_')}-${event}`);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.closeSync(fs.openSync(file, 'wx'));
  } catch (error) {
    if (error && error.code === 'EEXIST') return false;
    return true; // cannot tell; better to run twice than not at all
  }
  try { // keep the marker directory small: drop markers older than an hour now and then
    const entries = fs.readdirSync(dir);
    if (entries.length > 200) {
      const cutoff = Date.now() - 60 * 60 * 1000;
      for (const entry of entries) { const full = path.join(dir, entry); try { if (fs.statSync(full).mtimeMs < cutoff) fs.unlinkSync(full); } catch { /* raced */ } }
    }
  } catch { /* best effort */ }
  return true;
}

function sessionCachePath(sessionId) {
  return path.join(os.tmpdir(), 'waypoint-hook', `${String(sessionId).replace(/[^A-Za-z0-9_.-]/g, '_')}.json`);
}

function rememberSessionModel(sessionId, model) {
  if (!sessionId || !model) return;
  try {
    const file = sessionCachePath(sessionId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ model }));
  } catch {
    // best effort
  }
}

function recallSessionModel(sessionId) {
  if (!sessionId) return undefined;
  try {
    return JSON.parse(fs.readFileSync(sessionCachePath(sessionId), 'utf8')).model;
  } catch {
    return undefined;
  }
}

function detectModel(payload, env) {
  return (
    env.WAYPOINT_AGENT_MODEL
    || payload.model
    || recallSessionModel(payload.session_id || payload.sessionId)
    || modelFromTranscript(payload.transcript_path)
    || env.ANTHROPIC_MODEL
    || env.CLAUDE_MODEL
    || env.CODEX_MODEL
    || env.COPILOT_MODEL
    || undefined
  );
}

function clip(value, max) {
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim();
  if (!text) return undefined;
  return text.length > max ? text.slice(0, max) : text;
}

function collectTelemetry(payload, options) {
  const env = process.env;
  const cwd = payload.cwd || process.cwd();
  let user;
  try { user = os.userInfo().username; } catch { user = env.USER || env.USERNAME; }
  const agent = {
    harness: clip(options.harness || detectHarness(payload, env), 50),
    model: clip(detectModel(payload, env), 100),
    host: clip(os.hostname(), 100),
    os: clip(`${process.platform} ${os.release()}`, 100),
    user: clip(user, 100),
    cwd: clip(cwd, 500),
    plugin: clip(readPluginVersion(), 50),
  };
  Object.keys(agent).forEach((key) => agent[key] === undefined && delete agent[key]);
  return { agent, cwd };
}

function collectGit(cwd) {
  if (!git(cwd, ['rev-parse', '--is-inside-work-tree'])) return {};
  const branch = git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const repositoryUrl = git(cwd, ['remote', 'get-url', 'origin']);

  const files = new Set();
  const status = git(cwd, ['status', '--porcelain=v1', '-uall', '--no-renames']);
  if (status) {
    for (const line of status.split('\n')) {
      const file = line.slice(3).trim().replace(/^"|"$/g, '');
      if (file) files.add(file);
    }
  }

  // Commits and files on this branch that are not yet where they are going:
  // upstream if there is one, else the default branch. No base → nothing added,
  // rather than the whole history.
  let base;
  if (git(cwd, ['rev-parse', '--verify', '--quiet', '@{upstream}'])) base = '@{upstream}';
  else {
    for (const candidate of ['origin/main', 'origin/master', 'main', 'master']) {
      if (git(cwd, ['rev-parse', '--verify', '--quiet', candidate])) { base = candidate; break; }
    }
  }
  const commits = [];
  if (base && branch !== 'HEAD') {
    const log = git(cwd, ['log', '--pretty=format:%h %s', `${base}..HEAD`]);
    if (log) for (const line of log.split('\n')) if (line.trim()) commits.push(line.trim());
    const committed = git(cwd, ['diff', '--name-only', `${base}...HEAD`]);
    if (committed) for (const line of committed.split('\n')) if (line.trim()) files.add(line.trim());
  }

  return {
    branch: branch && branch !== 'HEAD' ? branch : undefined,
    repositoryUrl: repositoryUrl || undefined,
    files: [...files].map((file) => file.replace(/\\/g, '/')),
    commits,
    // How much of the work is still only on this machine (WP-0726): uncommitted paths and
    // commits the upstream has not got. Both are zero once the agent has committed and pushed.
    uncommitted: status ? status.split('\n').filter((line) => line.trim()).length : 0,
  };
}

/**
 * What to tell the model at a checkpoint or completion when its work has not left the
 * machine (WP-0726): the dashboard links tickets to branches and commits it can read from
 * the remote, so uncommitted or unpushed work is invisible there. Undefined when clean.
 */
function pushNudge(tool, gitInfo) {
  if (tool !== 'waypoint_checkpoint_run' && tool !== 'waypoint_complete_run') return undefined;
  const uncommitted = Number(gitInfo && gitInfo.uncommitted) || 0;
  const unpushed = Array.isArray(gitInfo && gitInfo.commits) ? gitInfo.commits.length : 0;
  if (!uncommitted && !unpushed) return undefined;
  const parts = [];
  if (uncommitted) parts.push(`${uncommitted} uncommitted change${uncommitted === 1 ? '' : 's'}`);
  if (unpushed) parts.push(`${unpushed} commit${unpushed === 1 ? '' : 's'} not pushed`);
  const branch = gitInfo && gitInfo.branch ? gitInfo.branch : '<branch>';
  const when = tool === 'waypoint_complete_run' ? 'before this run counts as done' : 'before going on';
  return `Waypoint: ${parts.join(' and ')} on ${branch}. Commit (message ending with the ticket id, e.g. "(WP-1234)") and push — git push -u origin ${branch} — ${when}; the dashboard links the ticket to its branch, commits and diff only from what is on the remote.`;
}

/**
 * Other worktrees on this repository (WP-0763): the local witness that more than one agent
 * is working here. `git worktree list --porcelain` lists the main worktree first; `others`
 * are the ones that are not the directory we are in. Nothing to fetch, nothing to trust.
 */
function collectWorktrees(cwd) {
  const list = git(cwd, ['worktree', 'list', '--porcelain']);
  if (!list) return { total: 0, others: [], isMain: true };
  const norm = (value) => String(value || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const entries = list.split(/\r?\n\s*\r?\n/).map((block) => {
    const lines = block.split(/\r?\n/);
    const worktree = (lines.find((line) => line.startsWith('worktree ')) || '').slice('worktree '.length).trim();
    const branch = (lines.find((line) => line.startsWith('branch ')) || '').slice('branch '.length).replace(/^refs\/heads\//, '').trim();
    return { path: worktree, branch: branch || undefined, bare: lines.some((line) => line.trim() === 'bare') };
  }).filter((entry) => entry.path && !entry.bare);
  const here = norm(git(cwd, ['rev-parse', '--show-toplevel']));
  const others = entries.filter((entry) => norm(entry.path) !== here).map((entry) => ({ path: entry.path, branch: entry.branch }));
  return { total: entries.length, others, isMain: entries.length ? norm(entries[0].path) === here : true };
}

/**
 * What to tell the model when other worktrees exist (WP-0763): at session start from the
 * main worktree (or from main/master anywhere), how to get its own; at a claim while on
 * main, branch before editing; at a checkpoint/completion with work sitting on main, that
 * another agent may be merging too. Quiet in a worktree of its own on its own branch, and
 * always quiet when no other worktree exists.
 */
function worktreeNudge(event, tool, gitInfo, worktrees) {
  const others = worktrees && Array.isArray(worktrees.others) ? worktrees.others : [];
  if (!others.length) return undefined;
  const branch = gitInfo && gitInfo.branch;
  const onMain = branch === 'main' || branch === 'master';
  const names = others.slice(0, 4).map((entry) => entry.branch || path.basename(String(entry.path || ''))).filter(Boolean).join(', ');
  const count = `${others.length} other worktree${others.length === 1 ? '' : 's'} on this repository${names ? ` (${names})` : ''}`;
  if (event === 'sessionstart') {
    if (!(worktrees.isMain || onMain)) return undefined;
    return `${count}: other agents are probably active here. Work in your own — git worktree add ../<repo>-wp-NNNN -b wp-NNNN-<slug>, then npm ci inside it (never junction node_modules into a worktree; git worktree remove follows the junction and deletes the target). Merge to main only when you are finishing the ticket, after git pull.`;
  }
  if (tool === 'waypoint_start_run' && onMain) {
    return `Waypoint: you are on ${branch} with ${count}. Claim, then branch or worktree before editing: git worktree add ../<repo>-wp-NNNN -b wp-NNNN-<slug>.`;
  }
  const dirty = (Number(gitInfo && gitInfo.uncommitted) || 0) > 0 || (Array.isArray(gitInfo && gitInfo.commits) && gitInfo.commits.length > 0);
  if ((tool === 'waypoint_checkpoint_run' || tool === 'waypoint_complete_run') && onMain && dirty) {
    return `Waypoint: work is sitting directly on ${branch} while ${count} — another agent may be merging into it too. Commit on a wp-NNNN branch and merge --no-ff after git pull, or move the changes to a worktree.`;
  }
  return undefined;
}

function union(existing, additions, cap, maxLength) {
  const out = [];
  const seen = new Set();
  for (const value of [...(Array.isArray(existing) ? existing : []), ...additions]) {
    const text = clip(value, maxLength);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
    if (out.length >= cap) break;
  }
  return out;
}

function matchedTool(toolName) {
  const name = String(toolName || '');
  return TOOL_SUFFIXES.find((suffix) => name === suffix || name.endsWith(`__${suffix}`) || name.endsWith(`_${suffix}`));
}

/** Pure: given the tool and its input, return the enriched input (or null if not ours). */
function enrichToolInput(toolName, input, telemetry, gitInfo) {
  const tool = matchedTool(toolName);
  if (!tool) return null;
  const current = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const next = { ...current };
  next.agent = { ...(telemetry.agent || {}), ...(current.agent && typeof current.agent === 'object' ? current.agent : {}) };

  if (tool === 'waypoint_start_run') {
    if (!next.branch && gitInfo.branch) next.branch = clip(gitInfo.branch, 200);
    if (!next.repositoryUrl && gitInfo.repositoryUrl) next.repositoryUrl = clip(gitInfo.repositoryUrl, 500);
  }
  if (tool === 'waypoint_checkpoint_run' || tool === 'waypoint_complete_run') {
    if (gitInfo.files && gitInfo.files.length) next.files = union(current.files, gitInfo.files, FILE_CAP, 500);
    if (gitInfo.commits && gitInfo.commits.length) next.commits = union(current.commits, gitInfo.commits, COMMIT_CAP, 500);
  }
  return next;
}

const debug = (...parts) => { if (process.env.WAYPOINT_DEBUG) process.stderr.write(`[waypoint-hook] ${parts.join(' ')}
`); };

async function main() {
  const options = parseArgs(process.argv.slice(2));
  debug('args', JSON.stringify(options));
  const payload = readStdin();
  debug('stdin read', Object.keys(payload).join(','));
  const event = options.event
    || String(payload.hook_event_name || (payload.toolName !== undefined ? 'PreToolUse' : '')).toLowerCase();
  // A harness interrupt that reaches us ends the wait quietly; the server abandons the
  // wait once the polls stop, so there is nothing else to do.
  const abort = new AbortController();
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
    try { process.on(sig, () => abort.abort()); } catch { /* not every platform has every signal */ }
  }

  if (event === 'collect') {
    const telemetry = collectTelemetry(payload, options);
    process.stdout.write(JSON.stringify({ ...telemetry.agent, git: collectGit(telemetry.cwd) }, null, 2));
    return;
  }

  if (event === 'sessionstart') {
    rememberSessionModel(payload.session_id || payload.sessionId, payload.model);
    const telemetry = collectTelemetry(payload, options);
    const summary = [telemetry.agent.harness, telemetry.agent.model, telemetry.agent.host].filter(Boolean).join(' · ');
    // Multi-agent awareness (WP-0763): say so only when another worktree exists.
    const worktreeLine = worktreeNudge('sessionstart', undefined, { branch: git(telemetry.cwd, ['rev-parse', '--abbrev-ref', 'HEAD']) }, collectWorktrees(telemetry.cwd));
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: `Waypoint plugin active (${summary}). Harness, model, host, branch, files and shell commands (exit codes → checks) attach to start_run/checkpoint_run/complete_run automatically — never retype them; the operator authorised this telemetry and the await_work repo list. Push your branch (git push -u origin <branch>) before every checkpoint and before completing.${worktreeLine ? ` ${worktreeLine}` : ''}`,
      },
    }));
    return;
  }

  const copilotCli = payload.toolName !== undefined && payload.tool_name === undefined;
  const toolName = copilotCli ? payload.toolName : payload.tool_name;
  const toolInput = copilotCli ? payload.toolArgs : payload.tool_input;
  if (!claimOnce(payload, event)) { debug('another hook source already handled this tool call'); return; }

  // Decision wait: the agent raised a blocking decision (PostToolUse) or is asking to
  // wait for one (PreToolUse). Either way the hook holds the turn until it is closed.
  // Shell commands (WP-0594): remember what ran and how it ended, for the next checkpoint.
  if ((event === 'posttooluse' || event === 'posttoolusefailure') && commandLog.isShellTool(toolName)) {
    commandLog.recordShellResult({ payload, toolName, copilotCli, failed: event === 'posttoolusefailure' });
    return;
  }
  if (event === 'posttooluse') {
    // Agent queue: the real waypoint_await_work has returned; poll with its waiterId until
    // the operator sends a command (work-wait.js).
    const out = workWait.isAwaitWorkTool(toolName)
      ? await workWait.handlePostAwaitWork({ payload, toolName, copilotCli, signal: abort.signal })
      : await decisionWait.handlePost({ payload, toolName, toolInput, copilotCli, signal: abort.signal });
    if (out) process.stdout.write(JSON.stringify(out));
    return;
  }
  if (event !== 'pretooluse') return;
  if (decisionWait.isAwaitTool(toolName)) {
    debug('await tool; calling handleAwait');
    const out = await decisionWait.handleAwait({ payload, toolName, toolInput, copilotCli, signal: abort.signal });
    debug('handleAwait returned', out ? 'output' : 'nothing');
    if (out) process.stdout.write(JSON.stringify(out));
    return;
  }
  if (workWait.isAwaitWorkTool(toolName)) {
    debug('await_work tool; calling handleAwaitWork');
    const telemetry = collectTelemetry(payload, options);
    const out = await workWait.handleAwaitWork({ payload, toolName, toolInput, copilotCli, telemetry, git, signal: abort.signal });
    debug('handleAwaitWork returned', out ? 'output' : 'nothing');
    if (out) process.stdout.write(JSON.stringify(out));
    return;
  }
  if (!matchedTool(toolName)) return;
  const telemetry = collectTelemetry(payload, options);
  const gitInfo = collectGit(telemetry.cwd);
  let updated = enrichToolInput(toolName, toolInput, telemetry, gitInfo);
  if (!updated) return;
  // Shell evidence: a new run starts with a clean slate; checkpoints and completion take
  // everything recorded since the last one (command-log.js).
  try {
    const pending = commandLog.pendingEntries(payload.session_id || payload.sessionId, telemetry.cwd);
    if (matchedTool(toolName) !== 'waypoint_start_run') updated = commandLog.attachCommandEvidence(updated, pending.entries);
    if (pending.entries.length) commandLog.markAttached(pending.file, pending.log);
  } catch { /* evidence is best effort */ }

  // Push discipline (WP-0726) and multi-agent worktree awareness (WP-0763) share one line of context.
  const nudge = [pushNudge(matchedTool(toolName), gitInfo), worktreeNudge(event, matchedTool(toolName), gitInfo, collectWorktrees(telemetry.cwd))].filter(Boolean).join('\n') || undefined;
  if (copilotCli) {
    process.stdout.write(JSON.stringify({ modifiedArgs: updated, ...(nudge ? { additionalContext: nudge } : {}) }));
    return;
  }
  // Claude Code applies updatedInput only alongside an explicit permission
  // decision. These three tools are the run's own bookkeeping, so the default is
  // to allow them; set WAYPOINT_HOOK_DECISION=ask to keep the prompt.
  const decision = process.env.WAYPOINT_HOOK_DECISION === 'ask' ? 'ask' : 'allow';
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision,
      permissionDecisionReason: 'Waypoint plugin attached harness telemetry',
      updatedInput: updated,
      // Uncommitted or unpushed work at a checkpoint/completion: say so in the model's
      // context (WP-0726); the server's ack repeats it for the unpushed commits it sees.
      ...(nudge ? { additionalContext: nudge } : {}),
    },
  }));
}

if (require.main === module) {
  // Nothing is left open when main() settles (no keep-alive sockets, no timers), so the
  // process ends on its own; a failure must never block the tool call.
  main().catch(() => { /* Never block the tool call. */ }).finally(() => { process.exitCode = 0; });
} else {
  module.exports = { enrichToolInput, matchedTool, detectHarness, collectGit, collectTelemetry, union, claimOnce, pushNudge, collectWorktrees, worktreeNudge };
}
