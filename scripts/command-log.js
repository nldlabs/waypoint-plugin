'use strict';
/**
 * Deterministic checkpoint evidence from the shell (WP-0594).
 *
 * PostToolUse (and PostToolUseFailure) on the harness's shell tool records every command
 * the agent ran, with its exit code and a short tail of output, in a per-session log under
 * the OS temp dir. When the agent later calls waypoint_checkpoint_run or
 * waypoint_complete_run, the PreToolUse hook attaches what was run since the last
 * checkpoint as `commands`, and turns the recognisable verification commands (typecheck,
 * test, build, lint, e2e) into `checks` with pass/fail from the exit code — so the model
 * never has to retype them, and cannot misreport them. waypoint_start_run resets the
 * cursor so one session that does several runs never bleeds evidence across them.
 *
 * Hook-derived checks are `required: false`: they are evidence, not gates. The model (or
 * the project's agent guide) still decides which checks must pass before completion.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const LOG_CAP = 300;           // entries kept per session
const COMMAND_MAX = 1000;      // server text limit for commands
const SUMMARY_MAX = 400;       // output tail kept per entry
const COMMANDS_CAP = 100;      // server array limit
const CHECKS_CAP = 50;

const SHELL_TOOLS = new Set(['bash', 'powershell', 'shell', 'local_shell', 'run_in_terminal', 'exec_command', 'execute_command', 'terminal']);

/** The harness's own shell tool — never an MCP tool. */
function isShellTool(toolName) {
  const name = String(toolName || '');
  if (!name || name.startsWith('mcp__')) return false;
  return SHELL_TOOLS.has(name.toLowerCase());
}

// Checks are named by what the command verifies; the first matching rule wins. e2e is
// tested before test because Playwright/Cypress commands usually also contain "test".
const CHECK_RULES = [
  ['e2e', /\b(playwright|cypress)\b|test:e2e|\be2e\b/i],
  ['typecheck', /\btsc\b|typecheck|\bmypy\b|\bpyright\b/i],
  ['test', /\b(jest|vitest|mocha|ava|pytest|phpunit|rspec|go test|cargo test|dotnet test|npm test|npm run test|pnpm test|yarn test|node --test|bun test)\b/i],
  ['lint', /\beslint\b|npm run lint|pnpm lint|yarn lint|\bruff\b|\bflake8\b|golangci-lint|cargo clippy|\bbiome\b/i],
  ['build', /npm run build|pnpm build|yarn build|vite build|\bcargo build\b|\bgo build\b|dotnet build|next build|\bwebpack\b|\besbuild\b|\btsc -b\b/i],
];

function checkNameFor(command) {
  const text = String(command || '');
  for (const [name, pattern] of CHECK_RULES) if (pattern.test(text)) return name;
  return undefined;
}

function logPath(sessionId, cwd, dir = os.tmpdir()) {
  const key = sessionId ? String(sessionId) : `cwd-${String(cwd || 'unknown').replace(/[^A-Za-z0-9]/g, '_').slice(-80)}`;
  return path.join(dir, 'waypoint-hook', `${key.replace(/[^A-Za-z0-9_.-]/g, '_')}-commands.json`);
}

function readLog(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { entries: Array.isArray(parsed.entries) ? parsed.entries : [], cursor: Number(parsed.cursor) || 0 };
  } catch {
    return { entries: [], cursor: 0 };
  }
}

function writeLog(file, log) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(log));
  } catch { /* best effort */ }
}

const text = (value) => (value === undefined || value === null ? '' : typeof value === 'string' ? value : (() => { try { return JSON.stringify(value); } catch { return String(value); } })());

/** The command string the harness ran, whatever it calls the argument. */
function commandFrom(toolInput) {
  if (!toolInput || typeof toolInput !== 'object') return typeof toolInput === 'string' ? toolInput : undefined;
  const value = toolInput.command || toolInput.cmd || toolInput.commandLine || toolInput.script;
  if (Array.isArray(value)) return value.join(' ');
  return value ? String(value) : undefined;
}

/**
 * Exit code and output tail from whatever the harness hands back. Claude Code's Bash
 * response carries stdout/stderr (and an "Exit code N" line when it failed); a
 * PostToolUseFailure event or an is_error/failure marker means non-zero even when no
 * number is given; an interrupted command is neither passed nor failed.
 */
function outcomeFrom(response, { failed = false } = {}) {
  const raw = response && typeof response === 'object' && Array.isArray(response.content) && response.content[0] && typeof response.content[0].text === 'string'
    ? response.content.map((part) => part.text || '').join('\n')
    : response;
  const object = raw && typeof raw === 'object' ? raw : {};
  const body = typeof raw === 'string' ? raw : [object.stdout, object.stderr, object.output, object.error, object.textResultForLlm, object.message].map(text).filter(Boolean).join('\n');
  let exitCode;
  for (const key of ['exit_code', 'exitCode', 'code', 'returncode', 'returnCode', 'status']) {
    if (typeof object[key] === 'number') { exitCode = object[key]; break; }
  }
  if (exitCode === undefined) {
    const match = body.match(/\bexit code[:\s]+(-?\d+)/i);
    if (match) exitCode = Number(match[1]);
  }
  const interrupted = object.interrupted === true || /\binterrupted\b/i.test(text(object.resultType));
  const markedFailed = failed || object.is_error === true || object.isError === true || object.success === false
    || /^(failure|failed|error)$/i.test(text(object.resultType));
  if (exitCode === undefined) exitCode = interrupted ? undefined : markedFailed ? 1 : 0;
  const tail = body.replace(/\r/g, '').trim();
  const summary = tail.length > SUMMARY_MAX ? `…${tail.slice(-SUMMARY_MAX)}` : tail;
  return { exitCode, interrupted, summary: summary || undefined };
}

/** PostToolUse / PostToolUseFailure on a shell tool: append one entry. Returns the entry or undefined. */
function recordShellResult({ payload, toolName, copilotCli, failed = false, dir, now = Date.now() }) {
  if (!isShellTool(toolName)) return undefined;
  const toolInput = copilotCli ? payload.toolArgs : payload.tool_input;
  const command = commandFrom(toolInput);
  if (!command || !command.trim()) return undefined;
  const response = copilotCli
    ? payload.toolResult
    : (payload.tool_response !== undefined ? payload.tool_response : (payload.tool_result !== undefined ? payload.tool_result : payload.error));
  const outcome = outcomeFrom(response, { failed });
  const entry = {
    command: command.trim().replace(/\s+/g, ' ').slice(0, COMMAND_MAX),
    exitCode: outcome.exitCode,
    interrupted: outcome.interrupted || undefined,
    summary: outcome.summary,
    at: new Date(now).toISOString(),
  };
  Object.keys(entry).forEach((key) => entry[key] === undefined && delete entry[key]);
  const file = logPath(payload.session_id || payload.sessionId, payload.cwd, dir);
  const log = readLog(file);
  log.entries.push(entry);
  if (log.entries.length > LOG_CAP) {
    const drop = log.entries.length - LOG_CAP;
    log.entries.splice(0, drop);
    log.cursor = Math.max(0, log.cursor - drop);
  }
  writeLog(file, log);
  return entry;
}

/** Entries recorded since the last checkpoint attached them. */
function pendingEntries(sessionId, cwd, dir) {
  const file = logPath(sessionId, cwd, dir);
  const log = readLog(file);
  return { file, log, entries: log.entries.slice(log.cursor) };
}

function markAttached(file, log) {
  writeLog(file, { entries: log.entries, cursor: log.entries.length });
}

/** One check per name from the recorded commands: the latest run of each wins. */
function deriveChecks(entries) {
  const byName = new Map();
  for (const entry of entries) {
    const name = checkNameFor(entry.command);
    if (!name) continue;
    const status = entry.interrupted || entry.exitCode === undefined ? 'skipped' : entry.exitCode === 0 ? 'passed' : 'failed';
    const check = { name, status, command: entry.command, required: false };
    if (typeof entry.exitCode === 'number') check.exitCode = entry.exitCode;
    if (entry.summary) check.summary = entry.summary;
    byName.set(name, check);
  }
  return [...byName.values()];
}

/**
 * Add the session's pending commands and derived checks to a checkpoint/complete input.
 * Model-supplied commands come first and model-supplied checks win by name; nothing the
 * model wrote is dropped. Returns the new input (the same object when nothing to add).
 */
function attachCommandEvidence(input, entries) {
  if (!entries || !entries.length) return input;
  const next = { ...input };
  const seen = new Set();
  const commands = [];
  for (const value of [...(Array.isArray(input.commands) ? input.commands : []), ...entries.map((entry) => entry.command)]) {
    const command = String(value || '').trim().slice(0, COMMAND_MAX);
    if (!command || seen.has(command)) continue;
    seen.add(command);
    commands.push(command);
  }
  next.commands = commands.slice(-COMMANDS_CAP);
  const modelChecks = Array.isArray(input.checks) ? input.checks.filter((check) => check && typeof check === 'object' && check.name) : [];
  const modelNames = new Set(modelChecks.map((check) => String(check.name)));
  const derived = deriveChecks(entries).filter((check) => !modelNames.has(check.name));
  if (derived.length) next.checks = [...modelChecks, ...derived].slice(0, CHECKS_CAP);
  return next;
}

module.exports = {
  isShellTool,
  checkNameFor,
  commandFrom,
  outcomeFrom,
  recordShellResult,
  pendingEntries,
  markAttached,
  deriveChecks,
  attachCommandEvidence,
  logPath,
  SHELL_TOOLS,
};
