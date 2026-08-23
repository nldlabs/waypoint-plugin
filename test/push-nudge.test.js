'use strict';
// Commit-and-push nudge at checkpoints and completion (WP-0726): the dashboard links a
// ticket to its branch, commits and diff from what is on the remote, so the hook tells the
// model when its work is still only on this machine — and says nothing when it is clean.
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOOK = path.join(__dirname, '..', 'scripts', 'waypoint-hook.js');
const hook = require(HOOK);

function git(cwd, ...args) { return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); }
function runHook(payload, args = []) {
  const out = execFileSync(process.execPath, [HOOK, ...args], { input: JSON.stringify(payload), encoding: 'utf8' });
  return out.trim() ? JSON.parse(out) : undefined;
}

test('pushNudge: silent when clean, names uncommitted changes and unpushed commits, and only at checkpoint/complete', () => {
  assert.equal(hook.pushNudge('waypoint_checkpoint_run', { uncommitted: 0, commits: [] }), undefined);
  assert.equal(hook.pushNudge('waypoint_start_run', { uncommitted: 3, commits: ['a b'] }), undefined);
  const both = hook.pushNudge('waypoint_complete_run', { branch: 'wp-0726-code-links', uncommitted: 2, commits: ['abc1 one', 'abc2 two'] });
  assert.match(both, /2 uncommitted changes and 2 commits not pushed on wp-0726-code-links/);
  assert.match(both, /git push -u origin wp-0726-code-links/);
  assert.match(both, /before this run counts as done/);
  const one = hook.pushNudge('waypoint_checkpoint_run', { uncommitted: 1, commits: [] });
  assert.match(one, /1 uncommitted change on <branch>/);
  assert.match(one, /before going on/);
});

test('as a child process: a dirty branch gets additionalContext at checkpoint, a clean one does not', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'waypoint-nudge-'));
  try {
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', 'hook@test'); git(repo, 'config', 'user.name', 'hook');
    fs.writeFileSync(path.join(repo, 'base.txt'), 'base'); git(repo, 'add', '.'); git(repo, 'commit', '-q', '-m', 'base');
    git(repo, 'checkout', '-q', '-b', 'wp-0726-code-links');
    const payload = (tool) => ({ hook_event_name: 'PreToolUse', tool_name: `mcp__waypoint__waypoint_${tool}`, tool_input: { projectId: 'p', runId: 'r', checkpoints: ['x'] }, cwd: repo });
    // Clean tree, nothing unpushed (no upstream and no origin/main: no base → no commits listed).
    const clean = runHook(payload('checkpoint_run'), ['--harness', 'claude-code']);
    assert.equal(clean.hookSpecificOutput.additionalContext, undefined);
    // Dirty tree.
    fs.writeFileSync(path.join(repo, 'wip.ts'), 'x');
    const dirty = runHook(payload('checkpoint_run'), ['--harness', 'claude-code']);
    assert.match(dirty.hookSpecificOutput.additionalContext, /1 uncommitted change on wp-0726-code-links/);
    assert.ok(dirty.hookSpecificOutput.updatedInput.files.includes('wip.ts'), 'the file still rides along as evidence');
    // Committed but not on main: counted as unpushed against the local main base.
    git(repo, 'add', '.'); git(repo, 'commit', '-q', '-m', 'wip (WP-0726)');
    const unpushed = runHook(payload('complete_run'), ['--harness', 'claude-code']);
    assert.match(unpushed.hookSpecificOutput.additionalContext, /1 commit not pushed on wp-0726-code-links/);
    assert.match(unpushed.hookSpecificOutput.additionalContext, /before this run counts as done/);
    // Copilot CLI shape carries the same nudge beside modifiedArgs.
    const copilot = runHook({ toolName: 'waypoint_complete_run', toolArgs: { projectId: 'p', runId: 'r', status: 'completed' }, cwd: repo, sessionId: 's' });
    assert.match(copilot.additionalContext, /not pushed/);
    assert.ok(copilot.modifiedArgs);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
