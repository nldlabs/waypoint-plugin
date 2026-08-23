'use strict';
// Multi-agent worktree awareness (WP-0763): other worktrees on the repository are the local
// sign that more than one agent is working here. The hook says so at session start from the
// main worktree, at a claim made on main, and at a checkpoint/completion with work sitting on
// main — and says nothing in a worktree of its own, or when no other worktree exists.
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

test('worktreeNudge: quiet without other worktrees or in an own worktree on a branch; speaks from main/the main worktree', () => {
  const none = { total: 1, others: [], isMain: true };
  const two = { total: 3, others: [{ path: 'D:/repo-wp-0001', branch: 'wp-0001-a' }, { path: 'D:/repo-wp-0002', branch: 'wp-0002-b' }], isMain: true };
  assert.equal(hook.worktreeNudge('sessionstart', undefined, { branch: 'main' }, none), undefined);
  assert.equal(hook.worktreeNudge('sessionstart', undefined, { branch: 'wp-0003-c' }, { ...two, isMain: false }), undefined);
  const start = hook.worktreeNudge('sessionstart', undefined, { branch: 'main' }, two);
  assert.match(start, /2 other worktrees on this repository \(wp-0001-a, wp-0002-b\)/);
  assert.match(start, /git worktree add \.\.\/<repo>-wp-NNNN -b wp-NNNN-<slug>/);
  assert.match(start, /never junction node_modules/);
  // On main inside a secondary worktree still counts: main is the shared branch.
  assert.match(hook.worktreeNudge('sessionstart', undefined, { branch: 'main' }, { ...two, isMain: false }), /other agents are probably active/);
  // Claims on main: branch first. Claims on a wp branch: quiet.
  assert.match(hook.worktreeNudge('pretooluse', 'waypoint_start_run', { branch: 'main' }, two), /Claim, then branch or worktree before editing/);
  assert.equal(hook.worktreeNudge('pretooluse', 'waypoint_start_run', { branch: 'wp-0003-c' }, two), undefined);
  // Checkpoint/complete with work on main: warn; clean main or a branch: quiet.
  assert.match(hook.worktreeNudge('pretooluse', 'waypoint_checkpoint_run', { branch: 'main', uncommitted: 2, commits: [] }, two), /work is sitting directly on main/);
  assert.match(hook.worktreeNudge('pretooluse', 'waypoint_complete_run', { branch: 'master', uncommitted: 0, commits: ['abc one'] }, two), /merge --no-ff after git pull/);
  assert.equal(hook.worktreeNudge('pretooluse', 'waypoint_checkpoint_run', { branch: 'main', uncommitted: 0, commits: [] }, two), undefined);
  assert.equal(hook.worktreeNudge('pretooluse', 'waypoint_checkpoint_run', { branch: 'wp-0003-c', uncommitted: 2, commits: [] }, two), undefined);
});

test('as a child process: a repo with a second worktree nudges from the main worktree and stays quiet inside the other', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'waypoint-wt-'));
  const repo = path.join(root, 'repo');
  const other = path.join(root, 'repo-wp-0001');
  try {
    fs.mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', 'hook@test'); git(repo, 'config', 'user.name', 'hook');
    fs.writeFileSync(path.join(repo, 'base.txt'), 'base'); git(repo, 'add', '.'); git(repo, 'commit', '-q', '-m', 'base');
    // No other worktree yet: the SessionStart context stays short and says nothing about worktrees.
    const alone = runHook({ hook_event_name: 'SessionStart', session_id: `wt-${process.pid}`, cwd: repo }, ['--harness', 'claude-code']);
    assert.doesNotMatch(alone.hookSpecificOutput.additionalContext, /worktree/);
    const seen = hook.collectWorktrees(repo);
    assert.equal(seen.others.length, 0);
    assert.equal(seen.isMain, true);
    git(repo, 'worktree', 'add', '-q', other, '-b', 'wp-0001-first');
    const both = hook.collectWorktrees(repo);
    assert.equal(both.total, 2);
    assert.deepEqual(both.others.map((entry) => entry.branch), ['wp-0001-first']);
    assert.equal(both.isMain, true);
    const fromOther = hook.collectWorktrees(other);
    assert.equal(fromOther.isMain, false);
    assert.deepEqual(fromOther.others.map((entry) => entry.branch), ['main']);
    // SessionStart from the main worktree on main: the nudge rides along in the context.
    const start = runHook({ hook_event_name: 'SessionStart', session_id: `wt-${process.pid}-b`, cwd: repo }, ['--harness', 'claude-code']);
    assert.match(start.hookSpecificOutput.additionalContext, /1 other worktree on this repository \(wp-0001-first\)/);
    // SessionStart inside the secondary worktree on its own branch: quiet.
    const inside = runHook({ hook_event_name: 'SessionStart', session_id: `wt-${process.pid}-c`, cwd: other }, ['--harness', 'claude-code']);
    assert.doesNotMatch(inside.hookSpecificOutput.additionalContext, /other worktree/);
    // A claim from main: branch-first nudge beside the telemetry.
    const claim = runHook({ hook_event_name: 'PreToolUse', tool_name: 'mcp__waypoint__waypoint_start_run', tool_input: { projectId: 'p' }, cwd: repo }, ['--harness', 'claude-code']);
    assert.match(claim.hookSpecificOutput.additionalContext, /you are on main with 1 other worktree/);
    assert.equal(claim.hookSpecificOutput.updatedInput.branch, 'main');
    // The same claim from the worktree on its branch: no worktree line.
    const claimInside = runHook({ hook_event_name: 'PreToolUse', tool_name: 'mcp__waypoint__waypoint_start_run', tool_input: { projectId: 'p' }, cwd: other }, ['--harness', 'claude-code']);
    assert.equal(claimInside.hookSpecificOutput.additionalContext, undefined);
    // Dirty main at a checkpoint: both nudges, one per line.
    fs.writeFileSync(path.join(repo, 'wip.ts'), 'x');
    const checkpoint = runHook({ hook_event_name: 'PreToolUse', tool_name: 'mcp__waypoint__waypoint_checkpoint_run', tool_input: { projectId: 'p', runId: 'r', checkpoints: ['x'] }, cwd: repo }, ['--harness', 'claude-code']);
    const lines = checkpoint.hookSpecificOutput.additionalContext.split('\n');
    assert.equal(lines.length, 2);
    assert.match(lines[0], /1 uncommitted change on main/);
    assert.match(lines[1], /work is sitting directly on main while 1 other worktree/);
  } finally {
    try { git(repo, 'worktree', 'remove', '--force', other); } catch { /* best effort */ }
    fs.rmSync(root, { recursive: true, force: true });
  }
});
