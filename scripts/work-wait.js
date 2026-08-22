'use strict';
/**
 * Work wait — the agent queue half of the Waypoint hook (WP-0595, WP-0601, WP-0602).
 *
 * An agent with nothing to do calls waypoint_await_work. Two hooks cooperate:
 *
 *   PreToolUse  (fast)  attaches what the machine already knows — harness, model, host,
 *                       cwd, the repositories in reach — to the call's input. No network.
 *   PostToolUse (slow)  runs after the real call returned: it reads the waiterId from the
 *                       tool result and polls Waypoint with it, every ~30 s, until the
 *                       operator sends a command, then hands the command to the model as
 *                       additional context with the instruction to execute it, report back
 *                       (after + reply) and keep waiting.
 *
 * Why PostToolUse rather than holding the call in PreToolUse: the real call has already
 * been permitted and executed, so the queue entry the dashboard shows is one whose agent
 * really is waiting; the waiterId comes from the server, not from the hook joining on the
 * model's behalf; and harnesses that ignore updatedInput still get the wait. Every poll is
 * the heartbeat: an entry that goes unpolled longer than `waiterGraceMs` drops off the
 * dashboard, so a stopped agent needs no cleanup here.
 *
 * Shares transport, credentials, session-state helpers with decision-wait.js.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const decisionWait = require('./decision-wait');

const AWAIT_WORK_TOOL = 'waypoint_await_work';
const SERVER_HOLD_SECONDS = 20;
const DEFAULT_CHUNK_SECONDS = 25 * 60;
const DEFAULT_MAX_SECONDS = 6 * 60 * 60;
const DEFAULT_GRACE_MS = 3 * 60 * 1000;
const MAX_CONSECUTIVE_ERRORS = 10;
const ERROR_SCHEDULE = [5, 10, 20];
const REPO_CAP = 25;
// The queue is command and control: what matters is how fast a command is picked up, not
// how few polls an idle hour costs (a poll is one cheap request). So no back-off: a 20 s
// server hold, a 10 s gap, every ~30 s, for as long as the agent waits.
const QUEUE_GAP_SECONDS = 10;

function toolSuffix(toolName) {
  const name = String(toolName || '');
  const index = name.lastIndexOf('waypoint_');
  return index === -1 ? undefined : name.slice(index);
}

function isAwaitWorkTool(toolName) { return toolSuffix(toolName) === AWAIT_WORK_TOOL; }

const dbg = (...parts) => { if (process.env.WAYPOINT_DEBUG) process.stderr.write(`[work-wait] ${parts.join(' ')}\n`); };

// ---------------------------------------------------------------- workspace

function isRepo(dir) {
  try { return fs.existsSync(path.join(dir, '.git')); } catch { return false; }
}

function describeRepo(dir, git) {
  const entry = { path: dir.replace(/\\/g, '/') };
  const url = git(dir, ['remote', 'get-url', 'origin']);
  const branch = git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (url) entry.url = url;
  if (branch && branch !== 'HEAD') entry.branch = branch;
  return entry;
}

/**
 * What the agent can reach from here: the repository it is in (first), then its
 * sibling and child repositories by name. Bounded: one level either way, REPO_CAP.
 */
function collectWorkspace(cwd, git) {
  const repositories = [];
  const seen = new Set();
  const add = (dir) => {
    const key = path.resolve(dir);
    if (seen.has(key) || repositories.length >= REPO_CAP || !isRepo(key)) return;
    seen.add(key);
    repositories.push(describeRepo(key, git));
  };
  let root;
  try { root = git(cwd, ['rev-parse', '--show-toplevel']); } catch { root = undefined; }
  if (root) add(root);
  const parent = path.dirname(root || cwd);
  const listDirs = (dir) => {
    try { return fs.readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory() && !entry.name.startsWith('.')).map((entry) => path.join(dir, entry.name)); } catch { return []; }
  };
  for (const dir of listDirs(parent)) add(dir);
  if (!root) for (const dir of listDirs(cwd)) add(dir);
  return { cwd: String(cwd).replace(/\\/g, '/'), repositories };
}

// ---------------------------------------------------------------- the wait

const sleep = (ms, signal) => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms);
  if (signal) signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
});

function writeState(file, state) {
  try { fs.writeFileSync(file, JSON.stringify(state)); } catch { /* best effort */ }
}
function clearState(file) {
  try { fs.unlinkSync(file); } catch { /* already gone */ }
}
function readState(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}

/** Seconds between polls: flat, jittered, and always under the server's grace. */
function queueGapSeconds(graceMs = DEFAULT_GRACE_MS) {
  const ceiling = Math.max(5, Math.floor(graceMs / 1000) - SERVER_HOLD_SECONDS - 15);
  return Math.min(QUEUE_GAP_SECONDS * (0.9 + Math.random() * 0.2), ceiling);
}

/**
 * Poll the entry `waiterId` until a command lands, the chunk or total budget is spent, the
 * server keeps failing, or the process is told to stop. Returns
 * { status, response?, waiterId, reason?, polls, waitedMs, holdSeconds }.
 */
async function waitForWork(options) {
  const {
    endpoint, waiterId, stateFile: file, env = process.env,
    chunkMs = Number(env.WAYPOINT_WAIT_CHUNK_SECONDS || DEFAULT_CHUNK_SECONDS) * 1000,
    maxMs = Number(env.WAYPOINT_WAIT_MAX_SECONDS || DEFAULT_MAX_SECONDS) * 1000,
    timeScale = Number(env.WAYPOINT_WAIT_TIME_SCALE || 1),
    call = decisionWait.callTool, signal,
  } = options;
  const state = readState(file);
  // Same waiter as last chunk: the total budget continues; a new waiter starts it afresh.
  const resumed = Boolean(state.waiterId === waiterId && state.startedAt);
  const startedAt = resumed ? state.startedAt : Date.now();
  let graceMs = Number(state.graceMs || DEFAULT_GRACE_MS);
  let holdSeconds = Number(state.holdSeconds || SERVER_HOLD_SECONDS);
  let attempt = resumed ? Number(state.attempt || 0) : 0;
  let errors = 0;
  let polls = 0;
  const chunkStarted = Date.now();
  const save = () => writeState(file, { waiterId, startedAt, attempt, graceMs, holdSeconds, lastPollAt: Date.now() });
  save();

  for (;;) {
    if (signal && signal.aborted) return { status: 'aborted', waiterId, polls, waitedMs: Date.now() - chunkStarted, holdSeconds };
    let response;
    dbg('poll', attempt, waiterId, endpoint.url);
    try {
      response = await call(endpoint, AWAIT_WORK_TOOL, { waiterId, waitSeconds: holdSeconds });
      errors = 0;
      polls += 1;
      if (response && Number(response.waiterGraceMs) > 0) graceMs = Number(response.waiterGraceMs);
      dbg('poll result', response && response.status);
    } catch (error) {
      errors += 1;
      if (/^HTTP 5\d\d/.test(String(error && error.message)) && holdSeconds > 5) holdSeconds = Math.max(5, Math.floor(holdSeconds / 2));
      dbg('poll error', String(error && error.message));
      if (errors >= MAX_CONSECUTIVE_ERRORS) return { status: 'error', reason: String(error && error.message || error), waiterId, polls, waitedMs: Date.now() - chunkStarted, holdSeconds };
      await sleep(ERROR_SCHEDULE[Math.min(errors - 1, ERROR_SCHEDULE.length - 1)] * 1000 * timeScale, signal);
      continue;
    }
    if (response && response.status === 'dismissed') {
      clearState(file);
      return { status: 'dismissed', response, waiterId, polls, waitedMs: Date.now() - chunkStarted, holdSeconds };
    }
    if (response && response.status === 'message') {
      // Keep the waiterId; the next wait (after the ack) starts its budget over.
      writeState(file, { waiterId, graceMs, holdSeconds, lastPollAt: Date.now() });
      return { status: 'message', response, waiterId, polls, waitedMs: Date.now() - chunkStarted, holdSeconds };
    }
    attempt += 1;
    save();
    if (Date.now() - startedAt >= maxMs) return { status: 'waiting', reason: 'max', response, waiterId, polls, waitedMs: Date.now() - chunkStarted, holdSeconds };
    if (Date.now() - chunkStarted >= chunkMs) return { status: 'waiting', reason: 'chunk', response, waiterId, polls, waitedMs: Date.now() - chunkStarted, holdSeconds };
    await sleep(queueGapSeconds(graceMs) * 1000 * timeScale, signal);
  }
}

function commandContext(message, waiterId) {
  const where = message.projectId ? ` (project ${message.projectId}${message.workId ? `, work ${message.workId}` : ''})` : '';
  return `Command from the operator${where}: "${message.text}". Execute it now — if it names a project or work, call waypoint_get_project_context, claim with waypoint_start_run, and checkpoint as usual. When it is done, report back and rejoin the queue in one call: waypoint_await_work with waiterId ${waiterId}, after "${message.id}", and reply = a short report of what you did and found (ids, branches, outcomes; the operator reads it on the dashboard). Then keep waiting for the next command.`;
}

function describeOutcome(result) {
  const r = result.response || {};
  const id = result.waiterId || r.waiterId;
  if (result.status === 'message' && r.message) return commandContext(r.message, id);
  if (result.status === 'dismissed') return 'The operator removed you from the agent queue. Stop waiting; rejoin with waypoint_await_work (no waiterId) only if asked to.';
  if (result.status === 'waiting') {
    const minutes = Math.round(result.waitedMs / 60000);
    return result.reason === 'max'
      ? `No command arrived in the maximum wait (${minutes} min). Stop waiting and say so; the operator can command you later if you rejoin.`
      : `Still waiting for a command; the Waypoint hook polled for ${minutes} min. Call waypoint_await_work again immediately with waiterId ${id} to keep your place in the queue.`;
  }
  if (result.status === 'error') return `Waypoint could not be reached while waiting for a command (${result.reason}). Call waypoint_await_work again in a minute${id ? ` with waiterId ${id}` : ''}.`;
  return undefined;
}

/** The input the real call carries: what the model said, filled in from the machine. */
function enrichInput(toolInput, telemetry, workspace) {
  const current = toolInput && typeof toolInput === 'object' ? toolInput : {};
  const agent = { ...((telemetry && telemetry.agent) || {}), ...(current.agent && typeof current.agent === 'object' ? current.agent : {}) };
  const supplied = current.workspace && typeof current.workspace === 'object' ? current.workspace : {};
  const merged = {
    ...(supplied.cwd || (workspace && workspace.cwd) ? { cwd: supplied.cwd || workspace.cwd } : {}),
    ...((Array.isArray(supplied.repositories) && supplied.repositories.length) ? { repositories: supplied.repositories }
      : (workspace && workspace.repositories && workspace.repositories.length) ? { repositories: workspace.repositories } : {}),
  };
  const next = { ...current };
  if (Object.keys(agent).length) next.agent = agent;
  if (Object.keys(merged).length) next.workspace = merged;
  return next;
}

/**
 * PreToolUse on waypoint_await_work: attach agent telemetry and the workspace. Never
 * waits, never touches the network. Returns the hook's stdout JSON, or undefined.
 */
function handleAwaitWork({ payload, toolName, toolInput, copilotCli, telemetry, git }) {
  if (!isAwaitWorkTool(toolName)) return undefined;
  const cwd = payload.cwd || process.cwd();
  const workspace = git ? collectWorkspace(cwd, git) : { cwd };
  const enriched = enrichInput(toolInput, telemetry, workspace);
  if (copilotCli) return { permissionDecision: 'allow', permissionDecisionReason: 'Waypoint plugin attached agent telemetry and workspace', modifiedArgs: enriched };
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      permissionDecisionReason: 'Waypoint plugin attached agent telemetry and workspace',
      updatedInput: enriched,
    },
  };
}

/**
 * PostToolUse on waypoint_await_work: the call has returned; if it says "waiting", poll
 * with its waiterId until a command arrives and append the command as context. A result
 * that already carries a command (the model acked one while another was queued) is
 * restated as context too, so the instruction to execute is never missed. Returns the
 * hook's stdout JSON, or undefined.
 */
async function handlePostAwaitWork({ payload, toolName, copilotCli, env = process.env, signal, call }) {
  if (!isAwaitWorkTool(toolName)) return undefined;
  const result = decisionWait.parseToolResult(payload, copilotCli);
  if (!result || typeof result !== 'object' || !result.waiterId) return undefined;
  const out = (context) => (copilotCli ? { additionalContext: context } : { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: context } });
  if (result.status === 'message' && result.message) return out(commandContext(result.message, result.waiterId));
  if (result.status === 'dismissed') return out(describeOutcome({ status: 'dismissed' }));
  if (result.status !== 'waiting') return undefined;
  // Without a way to poll, say so: left alone the model calls once and wanders off.
  const selfPoll = `so it cannot poll Waypoint on your behalf. Keep your place in the queue yourself: call waypoint_await_work again straight away with waiterId ${result.waiterId} and waitSeconds 20, and keep doing so while the result says status "waiting"; stop only when a command arrives or the operator dismisses you.`;
  if (env.WAYPOINT_WAIT_DISABLE === '1') return out(`The Waypoint plugin wait is disabled (WAYPOINT_WAIT_DISABLE=1), ${selfPoll}`);
  const endpoint = decisionWait.resolveEndpoint(env, os.homedir(), payload.cwd || process.cwd());
  if (!endpoint) return out(`The Waypoint plugin could not find the MCP URL and token for this machine (set WAYPOINT_MCP_URL and WAYPOINT_TOKEN in the environment, or configure the waypoint server with a Bearer header in ~/.claude.json, ~/.codex/config.toml or ~/.copilot/mcp-config.json), ${selfPoll}`);
  const file = decisionWait.stateFile(decisionWait.sessionKey(payload, env), 'work');
  const outcome = await waitForWork({ endpoint, waiterId: result.waiterId, stateFile: file, env, signal, call });
  if (outcome.status === 'aborted') return undefined;
  const context = describeOutcome(outcome);
  return context ? out(context) : undefined;
}

module.exports = {
  AWAIT_WORK_TOOL,
  QUEUE_GAP_SECONDS,
  collectWorkspace,
  commandContext,
  describeOutcome,
  enrichInput,
  handleAwaitWork,
  handlePostAwaitWork,
  isAwaitWorkTool,
  queueGapSeconds,
  readState,
  waitForWork,
};
