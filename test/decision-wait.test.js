'use strict';
// The decision wait, tested the way it runs: the hook as a child process, polling a local
// stand-in for Waypoint's MCP endpoint. WAYPOINT_WAIT_TIME_SCALE compresses the schedule
// so a "10 s" back-off is 10 ms here; the schedule itself is asserted separately.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const HOOK = path.join(ROOT, 'scripts', 'waypoint-hook.js');
const wait = require(path.join(ROOT, 'scripts', 'decision-wait.js'));

/** A tiny MCP server: tools/call waypoint_await_decision answers from a script of statuses. */
function mcpServer(script, { record = [] } = {}) {
  let calls = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const request = JSON.parse(body || '{}');
      record.push({ auth: req.headers.authorization, name: request.params && request.params.name, args: request.params && request.params.arguments });
      const step = script[Math.min(calls, script.length - 1)];
      calls += 1;
      if (step === 'http500') { res.writeHead(500); res.end('boom'); return; }
      const decisionId = request.params.arguments.decisionId;
      const payload = step === 'open'
        ? { decisionId, status: 'open', resumeAvailable: false, pollAfterMs: 10000, waitedMs: 0, waiterGraceMs: 360000 }
        : { decisionId, status: step, outcome: step === 'resolved' ? '24 hours' : 'abandoned', responseNote: step === 'resolved' ? 'Go with a day.' : 'Agent stopped waiting', resumeAvailable: true, pollAfterMs: 0, waitedMs: 0, waiterGraceMs: 360000 };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } }));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}/mcp`, calls: () => calls, close: () => new Promise((done) => server.close(done)) })));
}

// Asynchronous on purpose: the stand-in server lives in this process, so a synchronous
// child run would block the loop that has to answer the child's polls.
function runHook(payload, env, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HOOK, ...args], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`hook exited ${code}: ${stderr}`));
      try { resolve(stdout.trim() ? JSON.parse(stdout) : undefined); } catch (error) { reject(new Error(`bad hook output: ${stdout}`)); }
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

const fastEnv = (url, extra = {}) => ({ WAYPOINT_MCP_URL: url, WAYPOINT_TOKEN: 'wp_testtoken_0123456789abcdef', WAYPOINT_WAIT_TIME_SCALE: '0.001', TMPDIR: os.tmpdir(), ...extra });
const awaitCall = (sessionId = 'sess-1') => ({ hook_event_name: 'PreToolUse', session_id: sessionId, tool_name: 'mcp__waypoint__waypoint_await_decision', tool_input: { projectId: 'proj-1', decisionId: 'dec-1' }, cwd: os.tmpdir() });

test('the schedule starts at 10 s, backs off to 120 s, and never exceeds the server grace', () => {
  assert.equal(wait.SCHEDULE.slice(0, 6).every((value) => value === 10), true);
  assert.equal(wait.SCHEDULE[wait.SCHEDULE.length - 1], 60);
  const late = wait.backoffSeconds(500, 6 * 60 * 1000);
  assert.ok(late >= 108 && late <= 132, `tail ≈ 120 s ±10 %, got ${late}`);
  const tight = wait.backoffSeconds(500, 60 * 1000);
  assert.ok(tight <= 60 - 20 - 15, `clamped under grace - hold - slack, got ${tight}`);
  assert.ok(wait.backoffSeconds(0, 1000) >= 5, 'never below 5 s');
});

test('state is per session and per decision, so concurrent agents never share a wait', () => {
  const a = wait.stateFile(wait.sessionKey({ session_id: 'alpha' }), 'dec-1', '/tmp');
  const b = wait.stateFile(wait.sessionKey({ sessionId: 'beta' }), 'dec-1', '/tmp');
  const c = wait.stateFile(wait.sessionKey({ session_id: 'alpha' }), 'dec-2', '/tmp');
  assert.notEqual(a, b); assert.notEqual(a, c);
  assert.match(path.basename(a), /^waypoint-wait-alpha-dec-1\.json$/);
  // No session id at all: the parent process stands in, still one file per agent process.
  assert.match(wait.sessionKey({}, {}), /^pid\d+$/);
});

test('credentials: env wins, then Claude, Codex and Copilot configs; tokens never leak into state', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'waypoint-home-'));
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { waypoint: { type: 'http', url: 'https://c.example/mcp', headers: { Authorization: 'Bearer wp_claude_token' } } } }));
  fs.mkdirSync(path.join(home, '.codex'));
  fs.writeFileSync(path.join(home, '.codex', 'config.toml'), '[features]\nx = true\n\n[mcp_servers.waypoint]\nurl = "https://x.example/mcp"\nbearer_token_env_var = "WP_TOKEN"\n');
  fs.mkdirSync(path.join(home, '.copilot'));
  fs.writeFileSync(path.join(home, '.copilot', 'mcp-config.json'), JSON.stringify({ mcpServers: { waypoint: { type: 'http', url: 'https://p.example/mcp', headers: { Authorization: 'Bearer wp_copilot_token' } } } }));

  assert.deepEqual(wait.resolveEndpoint({ WAYPOINT_MCP_URL: 'https://e.example/mcp', WAYPOINT_TOKEN: 't' }, home, '/'), { url: 'https://e.example/mcp', token: 't', source: 'env' });
  assert.deepEqual(wait.resolveEndpoint({}, home, '/'), { url: 'https://c.example/mcp', token: 'wp_claude_token', source: 'claude' });
  fs.unlinkSync(path.join(home, '.claude.json'));
  // Codex names an env var for the token: without it the chain falls through to Copilot's config.
  assert.deepEqual(wait.resolveEndpoint({}, home, '/'), { url: 'https://p.example/mcp', token: 'wp_copilot_token', source: 'copilot' });
  assert.deepEqual(wait.resolveEndpoint({ WP_TOKEN: 'wp_codex_token' }, home, '/'), { url: 'https://x.example/mcp', token: 'wp_codex_token', source: 'codex' });
  fs.unlinkSync(path.join(home, '.codex', 'config.toml'));
  fs.unlinkSync(path.join(home, '.copilot', 'mcp-config.json'));
  assert.equal(wait.resolveEndpoint({}, home, '/'), undefined, 'nothing configured: the hook stays out of the way');
  fs.rmSync(home, { recursive: true, force: true });
});

test('as a child process against a stand-in MCP server', async (t) => {
  await t.test('resolves on the third poll: allow, waitSeconds 0, outcome in context; each poll carried the token', async () => {
    const record = [];
    const mcp = await mcpServer(['open', 'open', 'resolved'], { record });
    t.after(() => mcp.close());
    const out = await runHook(awaitCall(), fastEnv(mcp.url));
    assert.equal(mcp.calls(), 3);
    assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
    assert.equal(out.hookSpecificOutput.permissionDecision, 'allow');
    assert.deepEqual(out.hookSpecificOutput.updatedInput, { projectId: 'proj-1', decisionId: 'dec-1', waitSeconds: 0 });
    assert.match(out.hookSpecificOutput.additionalContext, /resolved by the operator: "24 hours"/);
    assert.match(out.hookSpecificOutput.additionalContext, /waypoint_resume_run/);
    assert.ok(record.every((call) => call.auth === 'Bearer wp_testtoken_0123456789abcdef' && call.name === 'waypoint_await_decision' && call.args.waitSeconds === 20));
    assert.equal(fs.existsSync(wait.stateFile('sess-1', 'dec-1')), false, 'state cleared once closed');
  });

  await t.test('still open at the chunk cap: allow with waitSeconds 20 and "call again", state kept for the next chunk', async () => {
    const mcp = await mcpServer(['open']);
    t.after(() => mcp.close());
    const file = wait.stateFile('sess-chunk', 'dec-1');
    fs.rmSync(file, { force: true });
    // Chunk of 0 s: one poll, then hand back.
    const out = await runHook(awaitCall('sess-chunk'), fastEnv(mcp.url, { WAYPOINT_WAIT_CHUNK_SECONDS: '0' }));
    assert.equal(out.hookSpecificOutput.updatedInput.waitSeconds, 20);
    assert.match(out.hookSpecificOutput.additionalContext, /still open.*call waypoint_await_decision again/i);
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(state.attempt, 1);
    assert.equal(state.decisionId, 'dec-1');
    assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /wp_testtoken/);
    // The next chunk resumes the back-off where it left off.
    await runHook(awaitCall('sess-chunk'), fastEnv(mcp.url, { WAYPOINT_WAIT_CHUNK_SECONDS: '0' }));
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).attempt, 2);
    fs.rmSync(file, { force: true });
  });

  await t.test('server errors retry rather than abort, and the token never appears in output', async () => {
    const mcp = await mcpServer(['http500', 'http500', 'resolved']);
    t.after(() => mcp.close());
    const out = await runHook(awaitCall('sess-err'), fastEnv(mcp.url));
    assert.equal(mcp.calls(), 3);
    assert.equal(out.hookSpecificOutput.updatedInput.waitSeconds, 0);
    assert.doesNotMatch(JSON.stringify(out), /wp_testtoken/);
  });

  await t.test('Copilot CLI payload shape: modifiedArgs, no hookSpecificOutput', async () => {
    const mcp = await mcpServer(['resolved']);
    t.after(() => mcp.close());
    const out = await runHook({ sessionId: 'cop-1', toolName: 'mcp__waypoint__waypoint_await_decision', toolArgs: { projectId: 'proj-1', decisionId: 'dec-9' }, cwd: os.tmpdir() }, fastEnv(mcp.url), ['--harness', 'copilot-cli']);
    assert.equal(out.permissionDecision, 'allow');
    assert.deepEqual(out.modifiedArgs, { projectId: 'proj-1', decisionId: 'dec-9', waitSeconds: 0 });
    assert.equal(out.hookSpecificOutput, undefined);
  });

  await t.test('PostToolUse on raise_decision: a blocking result starts the wait and the outcome is appended as context', async () => {
    const mcp = await mcpServer(['open', 'dismissed']);
    t.after(() => mcp.close());
    const out = await runHook({
      hook_event_name: 'PostToolUse', session_id: 'post-1', tool_name: 'mcp__waypoint__waypoint_raise_decision',
      tool_input: { projectId: 'proj-1', title: 'Which?' },
      tool_response: JSON.stringify({ id: 'dec-7', blocking: true, status: 'open' }),
      cwd: os.tmpdir(),
    }, fastEnv(mcp.url), ['--event', 'posttooluse']);
    assert.equal(mcp.calls(), 2);
    assert.equal(out.hookSpecificOutput.hookEventName, 'PostToolUse');
    assert.match(out.hookSpecificOutput.additionalContext, /closed without approval \(abandoned\)/);
  });

  await t.test('PostToolUse on a non-blocking result does nothing', async () => {
    const mcp = await mcpServer(['resolved']);
    t.after(() => mcp.close());
    const out = await runHook({ hook_event_name: 'PostToolUse', session_id: 'post-2', tool_name: 'mcp__waypoint__waypoint_raise_decision', tool_input: { projectId: 'proj-1' }, tool_response: JSON.stringify({ id: 'dec-8', blocking: false }) }, fastEnv(mcp.url), ['--event', 'posttooluse']);
    assert.equal(out, undefined);
    assert.equal(mcp.calls(), 0);
  });

  await t.test('no credentials: the call proceeds untouched', async () => {
    const out = await runHook(awaitCall('sess-nocreds'), { WAYPOINT_MCP_URL: '', WAYPOINT_TOKEN: '', HOME: os.tmpdir(), USERPROFILE: os.tmpdir(), WAYPOINT_WAIT_TIME_SCALE: '0.001' });
    assert.equal(out, undefined);
  });

  await t.test('SIGTERM mid-wait exits cleanly with no output (the server abandons the wait when polls stop)', async () => {
    const mcp = await mcpServer(['open']);
    t.after(() => mcp.close());
    const child = spawn(process.execPath, [HOOK], { env: { ...process.env, ...fastEnv(mcp.url, { WAYPOINT_WAIT_TIME_SCALE: '1' }) }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stdin.end(JSON.stringify(awaitCall('sess-term')));
    await new Promise((resolve) => setTimeout(resolve, 400));
    child.kill('SIGTERM');
    const code = await new Promise((resolve) => child.on('exit', (exitCode, signal) => resolve({ exitCode, signal })));
    assert.equal(stdout.trim(), '');
    assert.ok(code.exitCode === 0 || code.signal === 'SIGTERM' || code.exitCode === null);
  });
});
