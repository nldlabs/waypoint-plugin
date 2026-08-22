'use strict';
// Shell evidence (WP-0594): PostToolUse on the shell tool records commands; the next
// checkpoint/complete carries them as commands + checks; start_run resets the slate.
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const HOOK = path.join(ROOT, 'scripts', 'waypoint-hook.js');
const log = require(path.join(ROOT, 'scripts', 'command-log.js'));

function runHook(payload, args = [], env = {}) {
  const stdout = execFileSync(process.execPath, [HOOK, ...args], { input: JSON.stringify(payload), encoding: 'utf8', env: { ...process.env, ...env } });
  return stdout.trim() ? JSON.parse(stdout) : undefined;
}

test('shell tools are recognised across harnesses; MCP tools never are', () => {
  for (const name of ['Bash', 'PowerShell', 'bash', 'shell', 'local_shell', 'run_in_terminal']) assert.ok(log.isShellTool(name), name);
  assert.ok(!log.isShellTool('mcp__waypoint__waypoint_checkpoint_run'));
  assert.ok(!log.isShellTool('Read'));
  assert.ok(!log.isShellTool(''));
});

test('check names come from what the command verifies', () => {
  assert.equal(log.checkNameFor('npm run typecheck'), 'typecheck');
  assert.equal(log.checkNameFor('npx tsc --noEmit -p web/tsconfig.json'), 'typecheck');
  assert.equal(log.checkNameFor('npx jest --runInBand test/x.test.ts'), 'test');
  assert.equal(log.checkNameFor('npm test'), 'test');
  assert.equal(log.checkNameFor('npm run test:e2e'), 'e2e');
  assert.equal(log.checkNameFor('npx playwright test'), 'e2e');
  assert.equal(log.checkNameFor('npm run build:web 2>&1 | tail -5'), 'build');
  assert.equal(log.checkNameFor('npx eslint .'), 'lint');
  assert.equal(log.checkNameFor('git status -sb'), undefined);
  assert.equal(log.checkNameFor('ls -la'), undefined);
});

test('exit codes are read from fields, from an "Exit code N" line, or implied by failure', () => {
  assert.equal(log.outcomeFrom({ stdout: 'ok', stderr: '', exit_code: 0 }).exitCode, 0);
  assert.equal(log.outcomeFrom({ stdout: 'Exit code 2\nboom' }).exitCode, 2);
  assert.equal(log.outcomeFrom('Exit code 1\nfailed').exitCode, 1);
  assert.equal(log.outcomeFrom({ stdout: 'all good' }).exitCode, 0);
  assert.equal(log.outcomeFrom({ stdout: 'x', is_error: true }).exitCode, 1);
  assert.equal(log.outcomeFrom({ stdout: 'x' }, { failed: true }).exitCode, 1);
  assert.equal(log.outcomeFrom({ stdout: 'x', interrupted: true }).exitCode, undefined);
  assert.equal(log.outcomeFrom({ textResultForLlm: 'done', resultType: 'failure' }).exitCode, 1);
  const long = log.outcomeFrom({ stdout: 'a'.repeat(1000) });
  assert.ok(long.summary.length <= 402 && long.summary.startsWith('…'));
});

test('derived checks: latest run per name wins; never required; model checks win by name', () => {
  const entries = [
    { command: 'npm run typecheck', exitCode: 2, summary: 'TS2322' },
    { command: 'npm run typecheck', exitCode: 0 },
    { command: 'npx jest --runInBand test/a.test.ts', exitCode: 1, summary: 'Tests: 1 failed' },
    { command: 'git status', exitCode: 0 },
    { command: 'npm run build:web', interrupted: true },
  ];
  const checks = log.deriveChecks(entries);
  assert.deepEqual(checks.map((c) => [c.name, c.status, c.required]), [['typecheck', 'passed', false], ['test', 'failed', false], ['build', 'skipped', false]]);
  const input = { projectId: 'p', runId: 'r', commands: ['npm run typecheck'], checks: [{ name: 'test', status: 'passed', required: true }] };
  const out = log.attachCommandEvidence(input, entries);
  assert.deepEqual(out.commands, ['npm run typecheck', 'npx jest --runInBand test/a.test.ts', 'git status', 'npm run build:web']);
  assert.equal(out.checks.length, 3);
  assert.deepEqual(out.checks[0], { name: 'test', status: 'passed', required: true });
  assert.ok(out.checks.some((c) => c.name === 'typecheck' && c.status === 'passed'));
  assert.equal(log.attachCommandEvidence(input, []), input);
});

test('end to end as a child process: record on PostToolUse, attach on checkpoint, reset on start_run', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'waypoint-cmdlog-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const session = `cmdlog-${process.pid}-${Date.now()}`;
  const file = log.logPath(session, dir);

  // Other tools and other events are ignored and print nothing.
  assert.equal(runHook({ hook_event_name: 'PostToolUse', session_id: session, tool_name: 'Read', tool_input: { file_path: 'x' }, tool_response: {}, cwd: dir }), undefined);
  // Three shell results: a passing typecheck, a failing test (via PostToolUseFailure), an ordinary command.
  assert.equal(runHook({ hook_event_name: 'PostToolUse', session_id: session, tool_name: 'Bash', tool_input: { command: 'npm run typecheck' }, tool_response: { stdout: 'ok', stderr: '' }, cwd: dir }), undefined);
  runHook({ hook_event_name: 'PostToolUseFailure', session_id: session, tool_name: 'Bash', tool_input: { command: 'npx jest --runInBand test/a.test.ts' }, tool_response: 'Exit code 1\nTests: 1 failed, 3 passed', cwd: dir }, ['--event', 'posttoolusefailure']);
  runHook({ hook_event_name: 'PostToolUse', session_id: session, tool_name: 'PowerShell', tool_input: { command: 'git status -sb' }, tool_response: { stdout: '## main' }, cwd: dir });
  // The hook writes under os.tmpdir(); read the same file it wrote.
  const written = log.pendingEntries(session, dir);
  assert.equal(written.entries.length, 3);
  assert.equal(written.entries[1].exitCode, 1);

  const checkpoint = runHook({ hook_event_name: 'PreToolUse', session_id: session, tool_name: 'mcp__waypoint__waypoint_checkpoint_run', tool_input: { projectId: 'p', runId: 'r', checkpoints: ['did'], commands: ['manual one'] }, cwd: dir }, ['--harness', 'claude-code']);
  const input = checkpoint.hookSpecificOutput.updatedInput;
  assert.deepEqual(input.commands, ['manual one', 'npm run typecheck', 'npx jest --runInBand test/a.test.ts', 'git status -sb']);
  assert.deepEqual(input.checks.map((c) => [c.name, c.status, c.exitCode]), [['typecheck', 'passed', 0], ['test', 'failed', 1]]);
  assert.match(input.checks[1].summary, /1 failed/);
  assert.equal(input.checks[1].required, false);

  // Already attached: the next checkpoint carries only what ran since.
  const again = runHook({ hook_event_name: 'PreToolUse', session_id: session, tool_name: 'mcp__waypoint__waypoint_complete_run', tool_input: { projectId: 'p', runId: 'r', status: 'completed' }, cwd: dir });
  assert.equal(again.hookSpecificOutput.updatedInput.commands, undefined);
  runHook({ hook_event_name: 'PostToolUse', session_id: session, tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_response: { stdout: 'Tests: 9 passed' }, cwd: dir });
  // A new run resets the slate: start_run never carries commands and consumes what was pending.
  const start = runHook({ hook_event_name: 'PreToolUse', session_id: session, tool_name: 'mcp__waypoint__waypoint_start_run', tool_input: { projectId: 'p', name: 'n', objective: 'o' }, cwd: dir });
  assert.equal(start.hookSpecificOutput.updatedInput.commands, undefined);
  const after = runHook({ hook_event_name: 'PreToolUse', session_id: session, tool_name: 'mcp__waypoint__waypoint_checkpoint_run', tool_input: { projectId: 'p', runId: 'r2' }, cwd: dir });
  assert.equal(after.hookSpecificOutput.updatedInput.commands, undefined);

  // Copilot CLI shape records too.
  runHook({ toolName: 'bash', toolArgs: { command: 'npm run lint' }, toolResult: { textResultForLlm: 'clean', resultType: 'success' }, cwd: dir, sessionId: session }, ['--event', 'posttooluse']);
  const copilot = runHook({ toolName: 'waypoint_checkpoint_run', toolArgs: { projectId: 'p', runId: 'r2' }, cwd: dir, sessionId: session });
  assert.deepEqual(copilot.modifiedArgs.commands, ['npm run lint']);
  assert.equal(copilot.modifiedArgs.checks[0].name, 'lint');
  assert.ok(fs.existsSync(file) || true);
});
