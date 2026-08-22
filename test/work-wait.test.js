'use strict';
// The agent queue wait (WP-0595/0601/0602), tested the way it runs: the hook as a child
// process. PreToolUse enriches the call; PostToolUse takes the waiterId from the real
// call's result and polls a local stand-in for Waypoint until a command arrives.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const HOOK = path.join(ROOT, 'scripts', 'waypoint-hook.js');
const work = require(path.join(ROOT, 'scripts', 'work-wait.js'));
const wait = require(path.join(ROOT, 'scripts', 'decision-wait.js'));

/** A tiny MCP server: tools/call waypoint_await_work answers from a script of statuses. */
function mcpServer(script, { record = [] } = {}) {
  let calls = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const request = JSON.parse(body || '{}');
      const args = (request.params && request.params.arguments) || {};
      record.push({ auth: req.headers.authorization, name: request.params && request.params.name, args });
      const step = script[Math.min(calls, script.length - 1)];
      calls += 1;
      if (step === 'http500') { res.writeHead(500); res.end('boom'); return; }
      const waiterId = args.waiterId || 'w-1';
      const base = { waiterId, pollAfterMs: 10000, waitedMs: 0, waiterGraceMs: 180000, joinedAt: '2026-08-22T06:00:00.000Z', awaitCount: calls };
      const payload = step === 'waiting' ? { ...base, status: 'waiting', instructions: 'keep calling' }
        : step === 'dismissed' ? { ...base, status: 'dismissed', instructions: 'removed' }
        : { ...base, status: 'message', message: { id: 'm-1', text: 'Take WP-0591 on Waypoint', projectId: 'p-1', sentAt: '2026-08-22T06:01:00.000Z', deliveredAt: '2026-08-22T06:01:30.000Z' }, instructions: 'act' };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } }));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}/mcp`, calls: () => calls, close: () => new Promise((done) => server.close(done)) })));
}

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

function gitRepo(dir, remote) {
  fs.mkdirSync(dir, { recursive: true });
  const git = (...argv) => execFileSync('git', argv, { cwd: dir, stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@example.test'); git('config', 'user.name', 'T');
  if (remote) git('remote', 'add', 'origin', remote);
  fs.writeFileSync(path.join(dir, 'README.md'), '# x\n');
  git('add', '.'); git('commit', '-q', '-m', 'init');
  return dir;
}

const fastEnv = (url, extra = {}) => ({ WAYPOINT_MCP_URL: url, WAYPOINT_TOKEN: 'wp_testtoken_0123456789abcdef', WAYPOINT_WAIT_TIME_SCALE: '0.001', TMPDIR: os.tmpdir(), ...extra });
const preCall = (cwd, sessionId, toolInput = {}) => ({ hook_event_name: 'PreToolUse', session_id: sessionId, tool_name: 'mcp__waypoint__waypoint_await_work', tool_input: toolInput, cwd });
/** The real call returned `result`; this is what PostToolUse sees. */
const postCall = (cwd, sessionId, result, toolInput = {}) => ({
  hook_event_name: 'PostToolUse', session_id: sessionId, tool_name: 'mcp__waypoint__waypoint_await_work', tool_input: toolInput, cwd,
  tool_response: { content: [{ type: 'text', text: JSON.stringify(result) }] },
});
const waitingResult = (waiterId = 'w-1') => ({ waiterId, status: 'waiting', pollAfterMs: 10000, waitedMs: 20000, waiterGraceMs: 180000, instructions: 'keep calling' });

test('collectWorkspace reports the repository you are in first, then the repositories beside it', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'waypoint-ws-'));
  const here = gitRepo(path.join(home, 'waypoint'), 'https://github.com/nldlabs/waypoint.git');
  gitRepo(path.join(home, 'waypoint-plugin'), 'git@github.com:nldlabs/waypoint-plugin.git');
  fs.mkdirSync(path.join(home, 'notes'));
  fs.mkdirSync(path.join(here, 'lambda'));
  const git = (cwd, argv) => { try { return execFileSync('git', argv, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return undefined; } };
  const workspace = work.collectWorkspace(path.join(here, 'lambda'), git);
  assert.equal(workspace.cwd, path.join(here, 'lambda').replace(/\\/g, '/'));
  assert.equal(workspace.repositories.length, 2);
  assert.equal(workspace.repositories[0].url, 'https://github.com/nldlabs/waypoint.git');
  assert.equal(workspace.repositories[0].branch, 'main');
  assert.equal(workspace.repositories[1].url, 'git@github.com:nldlabs/waypoint-plugin.git');
  fs.rmSync(home, { recursive: true, force: true });
});

test('the queue polls on a flat ~30 s cycle (20 s hold + 10 s gap), clamped under the server grace', () => {
  assert.equal(work.QUEUE_GAP_SECONDS, 10);
  const gap = work.queueGapSeconds(3 * 60 * 1000);
  assert.ok(gap >= 9 && gap <= 11, `gap ≈ 10 s ±10 %, got ${gap}`);
  assert.ok(work.queueGapSeconds(40 * 1000) <= 5, 'never over grace - hold - slack');
});

test('enrichInput fills agent and workspace from the machine but never overrides what the model said', () => {
  const out = work.enrichInput(
    { note: 'idle', agent: { model: 'm' }, workspace: { cwd: '/custom' } },
    { agent: { harness: 'claude-code', model: 'ignored', host: 'h' } },
    { cwd: '/detected', repositories: [{ path: '/detected', url: 'u' }] },
  );
  assert.deepEqual(out, { note: 'idle', agent: { harness: 'claude-code', model: 'm', host: 'h' }, workspace: { cwd: '/custom', repositories: [{ path: '/detected', url: 'u' }] } });
});

test('as a child process against a stand-in MCP server', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'waypoint-ws-'));
  const here = gitRepo(path.join(home, 'repo'), 'https://github.com/nldlabs/waypoint.git');
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  await t.test('PreToolUse only enriches: agent + workspace attached, no network, no waiterId invented', async () => {
    const mcp = await mcpServer(['message']);
    t.after(() => mcp.close());
    const out = await runHook(preCall(here, 'work-pre', { note: 'Free for Waypoint work' }), fastEnv(mcp.url), ['--harness', 'claude-code']);
    assert.equal(mcp.calls(), 0, 'PreToolUse never polls');
    const hook = out.hookSpecificOutput;
    assert.equal(hook.hookEventName, 'PreToolUse');
    assert.equal(hook.permissionDecision, 'allow');
    assert.equal(hook.updatedInput.note, 'Free for Waypoint work');
    assert.equal(hook.updatedInput.agent.harness, 'claude-code');
    assert.equal(hook.updatedInput.workspace.cwd, here.replace(/\\/g, '/'));
    assert.equal(hook.updatedInput.workspace.repositories[0].url, 'https://github.com/nldlabs/waypoint.git');
    assert.equal(hook.updatedInput.waiterId, undefined);
    assert.equal(hook.additionalContext, undefined);
  });

  await t.test('PostToolUse polls with the waiterId the real call returned and hands the command to the model', async () => {
    const record = [];
    const mcp = await mcpServer(['waiting', 'waiting', 'message'], { record });
    t.after(() => mcp.close());
    const file = wait.stateFile('work-sess-1', 'work');
    fs.rmSync(file, { force: true });
    const out = await runHook(postCall(here, 'work-sess-1', waitingResult('w-real')), fastEnv(mcp.url));
    assert.equal(mcp.calls(), 3);
    assert.ok(record.every((call) => call.name === 'waypoint_await_work' && call.args.waiterId === 'w-real' && call.args.waitSeconds === 20 && call.auth === 'Bearer wp_testtoken_0123456789abcdef'));
    assert.equal(record[0].args.agent, undefined, 'polls carry only the waiterId; the real call already reported telemetry');
    const hook = out.hookSpecificOutput;
    assert.equal(hook.hookEventName, 'PostToolUse');
    assert.match(hook.additionalContext, /Command from the operator \(project p-1\): "Take WP-0591 on Waypoint"/);
    assert.match(hook.additionalContext, /waiterId w-real, after "m-1", and reply = a short report/);
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(state.waiterId, 'w-real');
    assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /wp_testtoken/);
    fs.rmSync(file, { force: true });
  });

  await t.test('a result that already carries a command is restated as context without polling', async () => {
    const mcp = await mcpServer(['waiting']);
    t.after(() => mcp.close());
    const result = { waiterId: 'w-2', status: 'message', message: { id: 'm-9', text: 'Deploy it', sentAt: 'x' }, pollAfterMs: 0, waitedMs: 0, waiterGraceMs: 180000 };
    const out = await runHook(postCall(here, 'work-direct', result), fastEnv(mcp.url));
    assert.equal(mcp.calls(), 0);
    assert.match(out.hookSpecificOutput.additionalContext, /Command from the operator: "Deploy it".*after "m-9"/);
  });

  await t.test('still waiting at the chunk cap: "call again with the waiterId"; the next chunk resumes the budget', async () => {
    const mcp = await mcpServer(['waiting']);
    t.after(() => mcp.close());
    const file = wait.stateFile('work-chunk', 'work');
    fs.rmSync(file, { force: true });
    const out = await runHook(postCall(here, 'work-chunk', waitingResult('w-1')), fastEnv(mcp.url, { WAYPOINT_WAIT_CHUNK_SECONDS: '0' }));
    assert.match(out.hookSpecificOutput.additionalContext, /still waiting.*call waypoint_await_work again immediately with waiterId w-1/i);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).attempt, 1);
    await runHook(postCall(here, 'work-chunk', waitingResult('w-1')), fastEnv(mcp.url, { WAYPOINT_WAIT_CHUNK_SECONDS: '0' }));
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).attempt, 2);
    fs.rmSync(file, { force: true });
  });

  await t.test('dismissed by the operator: the reason, state cleared', async () => {
    const mcp = await mcpServer(['waiting', 'dismissed']);
    t.after(() => mcp.close());
    const file = wait.stateFile('work-dismiss', 'work');
    const out = await runHook(postCall(here, 'work-dismiss', waitingResult('w-1')), fastEnv(mcp.url));
    assert.match(out.hookSpecificOutput.additionalContext, /removed you from the agent queue/i);
    assert.equal(fs.existsSync(file), false);
  });

  await t.test('server errors retry rather than abort; the token never appears in output', async () => {
    const mcp = await mcpServer(['http500', 'http500', 'message']);
    t.after(() => mcp.close());
    const out = await runHook(postCall(here, 'work-err', waitingResult('w-9')), fastEnv(mcp.url));
    assert.equal(mcp.calls(), 3);
    assert.match(out.hookSpecificOutput.additionalContext, /waiterId w-9, after "m-1"/);
    assert.doesNotMatch(JSON.stringify(out), /wp_testtoken/);
    fs.rmSync(wait.stateFile('work-err', 'work'), { force: true });
  });

  await t.test('Copilot CLI shapes: modifiedArgs on pre, additionalContext on post', async () => {
    const mcp = await mcpServer(['message']);
    t.after(() => mcp.close());
    const pre = await runHook({ toolName: 'waypoint_await_work', toolArgs: {}, cwd: here, sessionId: 'work-copilot' }, fastEnv(mcp.url), ['--event', 'pretooluse']);
    assert.equal(pre.permissionDecision, 'allow');
    assert.equal(pre.modifiedArgs.agent.harness, 'copilot-cli');
    const post = await runHook({ toolName: 'waypoint_await_work', toolArgs: {}, cwd: here, sessionId: 'work-copilot', toolResult: { textResultForLlm: JSON.stringify(waitingResult('w-c')) } }, fastEnv(mcp.url), ['--event', 'posttooluse']);
    assert.match(post.additionalContext, /waiterId w-c, after "m-1"/);
    fs.rmSync(wait.stateFile('work-copilot', 'work'), { force: true });
  });

  await t.test('no credentials: PostToolUse tells the model to keep polling itself with the waiterId', async () => {
    const out = await runHook(postCall(here, 'work-nocreds', waitingResult('w-5')), { WAYPOINT_MCP_URL: '', WAYPOINT_TOKEN: '', HOME: home, USERPROFILE: home, TMPDIR: os.tmpdir() });
    assert.match(out.hookSpecificOutput.additionalContext, /could not find the MCP URL and token.*call waypoint_await_work again straight away with waiterId w-5/);
  });

  await t.test('WAYPOINT_WAIT_DISABLE=1: no polling, the model is told to poll itself', async () => {
    const mcp = await mcpServer(['message']);
    t.after(() => mcp.close());
    const out = await runHook(postCall(here, 'work-off', waitingResult('w-6')), fastEnv(mcp.url, { WAYPOINT_WAIT_DISABLE: '1' }));
    assert.equal(mcp.calls(), 0);
    assert.match(out.hookSpecificOutput.additionalContext, /wait is disabled.*waiterId w-6/);
  });
});
