'use strict';
/**
 * Work wait — the agent queue half of the Waypoint hook (WP-0595).
 *
 * An agent with nothing to do calls waypoint_await_work. The PreToolUse hook on that tool
 * does what the decision wait does, turned around: it joins the queue on the agent's
 * behalf (the first poll creates the entry and returns a waiterId), attaches what the
 * machine already knows — harness, model, host, cwd, the repositories in reach — and
 * then polls Waypoint with the same back-off until the operator sends a message. Only
 * then does the real tool call go through, with the waiterId and waitSeconds: 0, so the
 * model sees one ordinary tool result carrying the operator's instructions.
 *
 * Every poll is the heartbeat: an entry that goes unpolled longer than `waiterGraceMs`
 * drops off the dashboard. A stopped agent therefore needs no cleanup here.
 *
 * Shares transport, credentials, schedule and state helpers with decision-wait.js.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const decisionWait = require('./decision-wait');

const AWAIT_WORK_TOOL = 'waypoint_await_work';
const SERVER_HOLD_SECONDS = 20;
const DEFAULT_CHUNK_SECONDS = 25 * 60;
const DEFAULT_MAX_SECONDS = 6 * 60 * 60;
const DEFAULT_GRACE_MS = 6 * 60 * 1000;
const MAX_CONSECUTIVE_ERRORS = 10;
const ERROR_SCHEDULE = [5, 10, 20];
const REPO_CAP = 25;

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

/**
 * Join (or resume) the queue and poll until a message lands, the chunk or total budget
 * is spent, the server keeps failing, or the process is told to stop. Returns
 * { status, response?, waiterId?, reason?, polls, waitedMs, holdSeconds }.
 */
async function waitForWork(options) {
  const {
    endpoint, input, stateFile: file, env = process.env,
    chunkMs = Number(env.WAYPOINT_WAIT_CHUNK_SECONDS || DEFAULT_CHUNK_SECONDS) * 1000,
    maxMs = Number(env.WAYPOINT_WAIT_MAX_SECONDS || DEFAULT_MAX_SECONDS) * 1000,
    timeScale = Number(env.WAYPOINT_WAIT_TIME_SCALE || 1),
    call = decisionWait.callTool, signal,
  } = options;
  const state = readState(file);
  let waiterId = input.waiterId || state.waiterId;
  // A fresh join (no waiterId) starts the back-off from the top; a resumed wait continues it.
  const resumed = Boolean(waiterId && state.waiterId === waiterId);
  const startedAt = resumed && state.startedAt ? state.startedAt : Date.now();
  let attempt = resumed ? Number(state.attempt || 0) : 0;
  let graceMs = Number(state.graceMs || DEFAULT_GRACE_MS);
  let holdSeconds = Number(state.holdSeconds || SERVER_HOLD_SECONDS);
  let errors = 0;
  let polls = 0;
  const chunkStarted = Date.now();
  const save = () => writeState(file, { waiterId, startedAt, attempt, graceMs, holdSeconds, lastPollAt: Date.now() });
  save();

  for (;;) {
    if (signal && signal.aborted) return { status: 'aborted', waiterId, polls, waitedMs: Date.now() - chunkStarted, holdSeconds };
    let response;
    dbg('poll', attempt, waiterId || '(join)', endpoint.url);
    try {
      response = await call(endpoint, AWAIT_WORK_TOOL, { ...input, ...(waiterId ? { waiterId } : {}), waitSeconds: holdSeconds });
      errors = 0;
      polls += 1;
      if (response && response.waiterId) waiterId = response.waiterId;
      if (response && Number(response.waiterGraceMs) > 0) graceMs = Number(response.waiterGraceMs);
      dbg('poll result', response && response.status, waiterId);
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
      // Keep the waiterId for the rejoin; the back-off starts over next time.
      writeState(file, { waiterId, graceMs, holdSeconds, lastPollAt: Date.now() });
      return { status: 'message', response, waiterId, polls, waitedMs: Date.now() - chunkStarted, holdSeconds };
    }
    attempt += 1;
    save();
    if (Date.now() - startedAt >= maxMs) return { status: 'waiting', reason: 'max', response, waiterId, polls, waitedMs: Date.now() - chunkStarted, holdSeconds };
    if (Date.now() - chunkStarted >= chunkMs) return { status: 'waiting', reason: 'chunk', response, waiterId, polls, waitedMs: Date.now() - chunkStarted, holdSeconds };
    await sleep(decisionWait.backoffSeconds(attempt - 1, graceMs) * 1000 * timeScale, signal);
  }
}

function writeState(file, state) {
  try { fs.writeFileSync(file, JSON.stringify(state)); } catch { /* best effort */ }
}
function clearState(file) {
  try { fs.unlinkSync(file); } catch { /* already gone */ }
}
function readState(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}

function describeOutcome(result) {
  const r = result.response || {};
  const id = result.waiterId || r.waiterId;
  if (result.status === 'message' && r.message) {
    const where = r.message.projectId ? ` (project ${r.message.projectId}${r.message.workId ? `, work ${r.message.workId}` : ''})` : '';
    return `Operator message for you${where}: "${r.message.text}". Act on it now — call waypoint_get_project_context for the project it names, claim work with waypoint_start_run, and checkpoint as usual. When you have finished, call waypoint_await_work again with waiterId ${id} and after "${r.message.id}" to rejoin the queue.`;
  }
  if (result.status === 'dismissed') return 'The operator removed you from the agent queue. Stop waiting; rejoin with waypoint_await_work (no waiterId) only if asked to.';
  if (result.status === 'waiting') {
    const minutes = Math.round(result.waitedMs / 60000);
    return result.reason === 'max'
      ? `No message arrived in the maximum wait (${minutes} min). Stop waiting and say so; the operator can message you later if you rejoin.`
      : `Still waiting for work; the Waypoint hook polled for ${minutes} min. Call waypoint_await_work again immediately with waiterId ${id} to keep your place in the queue.`;
  }
  if (result.status === 'error') return `Waypoint could not be reached while waiting for work (${result.reason}). Call waypoint_await_work again in a minute${id ? ` with waiterId ${id}` : ''}.`;
  return undefined;
}

/** The input the real call (and every poll) carries: what the model said, filled in from the machine. */
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
 * PreToolUse on waypoint_await_work. Always enriches the input; polls when Waypoint
 * credentials are in reach. Returns the hook's stdout JSON, or undefined to let the
 * call through untouched.
 */
async function handleAwaitWork({ payload, toolName, toolInput, copilotCli, telemetry, git, env = process.env, signal, call }) {
  if (!isAwaitWorkTool(toolName)) return undefined;
  const cwd = payload.cwd || process.cwd();
  const workspace = git ? collectWorkspace(cwd, git) : { cwd };
  const enriched = enrichInput(toolInput, telemetry, workspace);
  const allow = (updated, context) => (copilotCli
    ? { permissionDecision: 'allow', permissionDecisionReason: 'Waypoint plugin attached workspace and waited for work', modifiedArgs: updated }
    : {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        permissionDecisionReason: 'Waypoint plugin attached workspace and waited for work',
        updatedInput: updated,
        ...(context ? { additionalContext: context } : {}),
      },
    });
  // Without a way to poll, say so: left alone the model calls once and wanders off.
  const selfPoll = 'so it cannot poll Waypoint on your behalf. Keep your place in the queue yourself: while the result says status "waiting", call waypoint_await_work again straight away with the returned waiterId and waitSeconds 20, and stop only when a message arrives or the operator dismisses you.';
  if (env.WAYPOINT_WAIT_DISABLE === '1') return allow(enriched, `The Waypoint plugin wait is disabled (WAYPOINT_WAIT_DISABLE=1), ${selfPoll}`);
  const endpoint = decisionWait.resolveEndpoint(env, os.homedir(), cwd);
  if (!endpoint) return allow(enriched, `The Waypoint plugin could not find the MCP URL and token for this machine (set WAYPOINT_MCP_URL and WAYPOINT_TOKEN in the environment, or configure the waypoint server with a Bearer header in ~/.claude.json, ~/.codex/config.toml or ~/.copilot/mcp-config.json), ${selfPoll}`);
  const file = decisionWait.stateFile(decisionWait.sessionKey(payload, env), 'work');
  // The ack of a handled message is the model's to make; the hook only passes it once.
  const result = await waitForWork({ endpoint, input: enriched, stateFile: file, env, signal, call });
  if (result.status === 'aborted') return undefined;
  const closed = result.status === 'message' || result.status === 'dismissed';
  const updated = { ...enriched, ...(result.waiterId ? { waiterId: result.waiterId } : {}), waitSeconds: closed ? 0 : (result.holdSeconds || SERVER_HOLD_SECONDS) };
  // `after` was consumed by the first poll; sending it again on the real call would re-clear nothing harmful, but drop it for clarity.
  if (closed) delete updated.after;
  return allow(updated, describeOutcome(result));
}

module.exports = {
  AWAIT_WORK_TOOL,
  collectWorkspace,
  describeOutcome,
  enrichInput,
  handleAwaitWork,
  isAwaitWorkTool,
  readState,
  waitForWork,
};
