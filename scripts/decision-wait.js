'use strict';
/**
 * Decision wait — the part of the Waypoint hook that suspends the agent until the
 * operator answers a blocking decision.
 *
 * waypoint_await_decision can hold one call for at most 20 s (API Gateway). Left to the
 * model, the wait becomes "call once, wander off". Instead the PreToolUse hook on that
 * tool does the waiting: it polls Waypoint's MCP endpoint itself (each poll is a 20 s
 * server-side hold) with a back-off that starts at 10 s and settles at 2 min, and only
 * lets the real tool call through once the decision is closed — with waitSeconds: 0, so
 * the model sees one ordinary tool result carrying the answer. No model turns, no tokens.
 *
 * Every poll is also the waiter heartbeat: the server stamps the decision and keeps the
 * blocked run's lease alive, and abandons the wait (closing the decision, releasing the
 * run) if the polls stop for longer than `waiterGraceMs`. So there is nothing to do when
 * the operator interrupts the agent: the polls stop and the server cleans up. The hook
 * never fights a stop.
 *
 * State is per session *and* per decision (several agents share a machine), in the OS
 * temp dir, so a chunked wait resumes its back-off instead of restarting at 10 s.
 *
 * Zero dependencies (core http/https only). Never throws out of handle*(): on any failure
 * it returns undefined and the tool call proceeds unmodified.
 */

const fs = require('fs');
const http = require('http');
const https = require('https');
const os = require('os');
const path = require('path');

const AWAIT_TOOL = 'waypoint_await_decision';
const RAISE_TOOLS = ['waypoint_raise_decision', 'waypoint_propose_plan'];
const SERVER_HOLD_SECONDS = 20;
const DEFAULT_CHUNK_SECONDS = 25 * 60;
const DEFAULT_MAX_SECONDS = 6 * 60 * 60;
const DEFAULT_GRACE_MS = 6 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 40 * 1000;
const MAX_CONSECUTIVE_ERRORS = 10;
// Seconds between polls, on top of the server hold. Then 120 s for good.
const SCHEDULE = [10, 10, 10, 10, 10, 10, 20, 20, 20, 20, 20, 20, 30, 30, 30, 30, 60, 60, 60, 60, 60];
const SCHEDULE_TAIL = 120;
const ERROR_SCHEDULE = [5, 10, 20];

function toolSuffix(toolName) {
  const name = String(toolName || '');
  const index = name.lastIndexOf('waypoint_');
  return index === -1 ? undefined : name.slice(index);
}

function isAwaitTool(toolName) { return toolSuffix(toolName) === AWAIT_TOOL; }
function isRaiseTool(toolName) { return RAISE_TOOLS.includes(toolSuffix(toolName)); }

// ---------------------------------------------------------------- credentials

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return undefined; }
}

function bearer(headers) {
  if (!headers || typeof headers !== 'object') return undefined;
  const value = headers.Authorization || headers.authorization;
  if (typeof value !== 'string') return undefined;
  const match = value.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : undefined;
}

function fromClaude(home, cwd) {
  const config = readJson(path.join(home, '.claude.json'));
  if (!config) return undefined;
  const candidates = [];
  if (cwd && config.projects && config.projects[cwd] && config.projects[cwd].mcpServers) candidates.push(config.projects[cwd].mcpServers);
  if (config.mcpServers) candidates.push(config.mcpServers);
  for (const servers of candidates) {
    const server = servers.waypoint || Object.values(servers).find((entry) => entry && typeof entry.url === 'string' && /waypoint/i.test(entry.url));
    if (server && typeof server.url === 'string') {
      const token = bearer(server.headers);
      if (token) return { url: server.url, token, source: 'claude' };
    }
  }
  return undefined;
}

function fromCodex(home, env) {
  let text;
  try { text = fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8'); } catch { return undefined; }
  const section = text.split(/\n(?=\[)/).find((block) => /^\[mcp_servers\.waypoint\]/.test(block.trim()));
  if (!section) return undefined;
  const url = (section.match(/^\s*url\s*=\s*"([^"]+)"/m) || [])[1];
  if (!url) return undefined;
  const header = (section.match(/Authorization"?\s*=\s*"Bearer\s+([^"]+)"/i) || [])[1];
  if (header) return { url, token: header.trim(), source: 'codex' };
  const envName = (section.match(/^\s*bearer_token_env_var\s*=\s*"([^"]+)"/m) || [])[1];
  if (envName && env[envName]) return { url, token: env[envName], source: 'codex' };
  return undefined;
}

function fromCopilot(home) {
  const config = readJson(path.join(home, '.copilot', 'mcp-config.json'));
  const server = config && config.mcpServers && config.mcpServers.waypoint;
  if (!server || typeof server.url !== 'string') return undefined;
  const token = bearer(server.headers);
  return token ? { url: server.url, token, source: 'copilot' } : undefined;
}

/** Where to talk to Waypoint and as whom. Env wins; then whichever harness config has it. */
function resolveEndpoint(env = process.env, home = os.homedir(), cwd = process.cwd()) {
  if (env.WAYPOINT_MCP_URL && env.WAYPOINT_TOKEN) return { url: env.WAYPOINT_MCP_URL, token: env.WAYPOINT_TOKEN, source: 'env' };
  return fromClaude(home, cwd) || fromCodex(home, env) || fromCopilot(home) || undefined;
}

// ---------------------------------------------------------------- MCP client

async function callTool(endpoint, name, args, timeoutMs = REQUEST_TIMEOUT_MS) {
  // Core http/https with a fresh, non-keep-alive connection per poll: nothing pooled,
  // nothing left open, so the hook process ends the moment it has its answer.
  const target = new URL(endpoint.url);
  const client = target.protocol === 'http:' ? http : https;
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  const text = await new Promise((resolve, reject) => {
    const request = client.request(target, {
      method: 'POST',
      agent: false,
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        authorization: `Bearer ${endpoint.token}`,
        'content-length': Buffer.byteLength(body),
        connection: 'close',
      },
    }, (response) => {
      let data = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { data += chunk; });
      response.on('end', () => {
        if (response.statusCode < 200 || response.statusCode >= 300) reject(new Error(`HTTP ${response.statusCode}`));
        else resolve(data);
      });
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error('timeout')));
    request.on('error', reject);
    request.end(body);
  });
  const parsed = JSON.parse(text);
  if (parsed.error) throw new Error(`MCP ${parsed.error.code || ''}: ${parsed.error.message || 'error'}`);
  const content = parsed.result && parsed.result.content && parsed.result.content[0] && parsed.result.content[0].text;
  return content ? JSON.parse(content) : parsed.result;
}

// ---------------------------------------------------------------- schedule + state

function jitter(seconds) {
  return seconds * (0.9 + Math.random() * 0.2);
}

/** Seconds to sleep before poll number `attempt` (0-based), clamped under the server's grace. */
function backoffSeconds(attempt, graceMs = DEFAULT_GRACE_MS) {
  const planned = attempt < SCHEDULE.length ? SCHEDULE[attempt] : SCHEDULE_TAIL;
  // The server tolerates graceMs of silence; a poll takes up to one hold, and the
  // previous stamp happened at the *start* of the previous hold. Leave 15 s of slack.
  const ceiling = Math.max(5, Math.floor(graceMs / 1000) - SERVER_HOLD_SECONDS - 15);
  return Math.min(jitter(planned), ceiling);
}

function sanitize(value) {
  return String(value || '').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80);
}

function sessionKey(payload, env = process.env) {
  // Claude/Codex: session_id; Copilot: sessionId; otherwise the parent process id —
  // every concurrent agent gets its own file even on one machine.
  return sanitize(payload.session_id || payload.sessionId || env.WAYPOINT_SESSION_ID || `pid${process.ppid || process.pid}`);
}

function stateFile(sessionId, decisionId, dir = os.tmpdir()) {
  return path.join(dir, `waypoint-wait-${sanitize(sessionId)}-${sanitize(decisionId)}.json`);
}

function readState(file) { return readJson(file) || {}; }

function writeState(file, state) {
  try { fs.writeFileSync(file, JSON.stringify(state)); } catch { /* best effort */ }
}

function clearState(file) {
  try { fs.unlinkSync(file); } catch { /* already gone */ }
}

// ---------------------------------------------------------------- the wait

const sleep = (ms, signal) => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms);
  if (signal) signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
});

/**
 * Poll until the decision is closed, the chunk budget is spent, the total budget is
 * spent, the server keeps failing, or the process is told to stop. Returns
 * { status, response?, reason?, polls, waitedMs }.
 */
const dbg = (...parts) => { if (process.env.WAYPOINT_DEBUG) process.stderr.write(`[decision-wait] ${parts.join(' ')}
`); };

async function waitForDecision(options) {
  const {
    endpoint, projectId, decisionId, stateFile: file, env = process.env,
    chunkMs = Number(env.WAYPOINT_WAIT_CHUNK_SECONDS || DEFAULT_CHUNK_SECONDS) * 1000,
    maxMs = Number(env.WAYPOINT_WAIT_MAX_SECONDS || DEFAULT_MAX_SECONDS) * 1000,
    timeScale = Number(env.WAYPOINT_WAIT_TIME_SCALE || 1), // tests compress the clock
    call = callTool, signal,
  } = options;
  const state = readState(file);
  const startedAt = state.startedAt || Date.now();
  let attempt = Number(state.attempt || 0);
  let errors = 0;
  let graceMs = Number(state.graceMs || DEFAULT_GRACE_MS);
  const chunkStarted = Date.now();
  let polls = 0;
  writeState(file, { ...state, startedAt, attempt, decisionId, projectId, graceMs, lastPollAt: Date.now() });

  for (;;) {
    if (signal && signal.aborted) return { status: 'aborted', polls, waitedMs: Date.now() - chunkStarted };
    let response;
    dbg('poll', attempt, 'calling', endpoint.url);
    try {
      response = await call(endpoint, AWAIT_TOOL, { projectId, decisionId, waitSeconds: SERVER_HOLD_SECONDS });
      errors = 0;
      polls += 1;
      dbg('poll result', response && response.status);
      if (response && Number(response.waiterGraceMs) > 0) graceMs = Number(response.waiterGraceMs);
    } catch (error) {
      errors += 1;
      if (errors >= MAX_CONSECUTIVE_ERRORS) return { status: 'error', reason: String(error && error.message || error), polls, waitedMs: Date.now() - chunkStarted };
      const retry = ERROR_SCHEDULE[Math.min(errors - 1, ERROR_SCHEDULE.length - 1)];
      await sleep(retry * 1000 * timeScale, signal);
      continue;
    }
    if (response && response.status && response.status !== 'open') {
      clearState(file);
      return { status: response.status, response, polls, waitedMs: Date.now() - chunkStarted };
    }
    attempt += 1;
    writeState(file, { startedAt, attempt, decisionId, projectId, graceMs, lastPollAt: Date.now() });
    if (Date.now() - startedAt >= maxMs) return { status: 'open', reason: 'max', response, polls, waitedMs: Date.now() - chunkStarted };
    if (Date.now() - chunkStarted >= chunkMs) return { status: 'open', reason: 'chunk', response, polls, waitedMs: Date.now() - chunkStarted };
    await sleep(backoffSeconds(attempt - 1, graceMs) * 1000 * timeScale, signal);
  }
}

// ---------------------------------------------------------------- hook handlers

function describeOutcome(result) {
  const r = result.response || {};
  if (result.status === 'resolved') return `Decision ${r.decisionId} was resolved by the operator: "${r.outcome || ''}"${r.responseNote ? ` — ${r.responseNote}` : ''}.${r.resumeAvailable ? ' Call waypoint_resume_run to continue the blocked run.' : ''}`;
  if (result.status === 'dismissed') return `Decision ${r.decisionId} was closed without approval (${r.outcome || 'dismissed'})${r.responseNote ? `: ${r.responseNote}` : ''}.${r.resumeAvailable ? ' Call waypoint_resume_run if the work continues.' : ''}`;
  if (result.status === 'open') {
    const minutes = Math.round(result.waitedMs / 60000);
    return result.reason === 'max'
      ? `Decision is still open after the maximum wait (${minutes} min). Stop waiting and record where things stand.`
      : `Decision is still open; the Waypoint hook waited ${minutes} min. Call waypoint_await_decision again immediately to keep waiting.`;
  }
  if (result.status === 'error') return `Waypoint could not be reached while waiting (${result.reason}). Call waypoint_await_decision again in a minute.`;
  return undefined;
}

/**
 * PreToolUse on waypoint_await_decision. Returns the hook's stdout JSON, or undefined
 * to let the call through untouched.
 */
async function handleAwait({ payload, toolName, toolInput, copilotCli, env = process.env, signal, call }) {
  if (env.WAYPOINT_WAIT_DISABLE === '1') return undefined;
  if (!isAwaitTool(toolName) || !toolInput || !toolInput.projectId || !toolInput.decisionId) return undefined;
  const endpoint = resolveEndpoint(env, os.homedir(), payload.cwd || process.cwd());
  if (!endpoint) return undefined;
  const file = stateFile(sessionKey(payload, env), toolInput.decisionId);
  const result = await waitForDecision({ endpoint, projectId: toolInput.projectId, decisionId: toolInput.decisionId, stateFile: file, env, signal, call });
  if (result.status === 'aborted') return undefined;
  const closed = result.status !== 'open' && result.status !== 'error';
  const updated = { ...toolInput, waitSeconds: closed ? 0 : SERVER_HOLD_SECONDS };
  const context = describeOutcome(result);
  if (copilotCli) return { permissionDecision: 'allow', permissionDecisionReason: 'Waypoint plugin waited for the decision', modifiedArgs: updated };
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      permissionDecisionReason: closed ? 'Waypoint plugin waited for the decision; it is now closed' : 'Waypoint plugin waited for the decision',
      updatedInput: updated,
      ...(context ? { additionalContext: context } : {}),
    },
  };
}

function parseToolResult(payload, copilotCli) {
  const raw = copilotCli
    ? (payload.toolResult && (payload.toolResult.textResultForLlm || payload.toolResult))
    : (payload.tool_response !== undefined ? payload.tool_response : payload.tool_result);
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === 'object') {
    if (Array.isArray(raw.content) && raw.content[0] && typeof raw.content[0].text === 'string') {
      try { return JSON.parse(raw.content[0].text); } catch { return undefined; }
    }
    return raw;
  }
  try { return JSON.parse(String(raw)); } catch { return undefined; }
}

/**
 * PostToolUse on waypoint_raise_decision / waypoint_propose_plan: if the call blocked the
 * run, wait here and append the outcome. Returns stdout JSON or undefined.
 */
async function handlePost({ payload, toolName, toolInput, copilotCli, env = process.env, signal, call }) {
  if (env.WAYPOINT_WAIT_DISABLE === '1') return undefined;
  if (!isRaiseTool(toolName) || !toolInput || !toolInput.projectId) return undefined;
  const result = parseToolResult(payload, copilotCli);
  const decision = result && (result.decision || result);
  if (!decision || !decision.id || decision.blocking !== true) return undefined;
  const endpoint = resolveEndpoint(env, os.homedir(), payload.cwd || process.cwd());
  if (!endpoint) return undefined;
  const file = stateFile(sessionKey(payload, env), decision.id);
  const outcome = await waitForDecision({ endpoint, projectId: toolInput.projectId, decisionId: decision.id, stateFile: file, env, signal, call });
  if (outcome.status === 'aborted') return undefined;
  const context = describeOutcome(outcome);
  if (!context) return undefined;
  if (copilotCli) return { additionalContext: context };
  return { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: context } };
}

module.exports = {
  AWAIT_TOOL,
  RAISE_TOOLS,
  SCHEDULE,
  backoffSeconds,
  callTool,
  describeOutcome,
  handleAwait,
  handlePost,
  isAwaitTool,
  isRaiseTool,
  parseToolResult,
  resolveEndpoint,
  sessionKey,
  stateFile,
  waitForDecision,
};
