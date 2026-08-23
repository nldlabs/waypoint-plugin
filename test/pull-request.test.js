// Pull requests ride along on checkpoints and completions (WP-0766): the PR gh/glab reports for
// the branch is merged by URL into the call's pullRequests; nothing found adds nothing.
const test = require('node:test');
const assert = require('node:assert/strict');
const hook = require('../scripts/waypoint-hook.js');

test('enrich adds the branch pull request to checkpoint/complete, merging by url with what the agent gave', () => {
  const telemetry = { agent: { harness: 'claude-code' }, cwd: 'D:/x' };
  const gitInfo = { branch: 'wp-0766-run-pull-requests', pullRequest: { url: 'https://github.com/nldlabs/waypoint/pull/12', number: 12, title: 'Runs carry PRs (WP-0766)', state: 'open' } };
  const checkpoint = hook.enrichToolInput('mcp__waypoint__waypoint_checkpoint_run', { projectId: 'p', runId: 'r', pullRequests: [{ url: 'https://github.com/nldlabs/waypoint/pull/12', state: 'draft' }, { url: 'https://github.com/nldlabs/waypoint/pull/9' }] }, telemetry, gitInfo);
  assert.deepEqual(checkpoint.pullRequests, [
    { url: 'https://github.com/nldlabs/waypoint/pull/12', number: 12, title: 'Runs carry PRs (WP-0766)', state: 'open' },
    { url: 'https://github.com/nldlabs/waypoint/pull/9' },
  ]);
  const complete = hook.enrichToolInput('mcp__waypoint__waypoint_complete_run', { projectId: 'p', runId: 'r', status: 'completed' }, telemetry, gitInfo);
  assert.deepEqual(complete.pullRequests, [gitInfo.pullRequest]);
  const start = hook.enrichToolInput('mcp__waypoint__waypoint_start_run', { projectId: 'p', name: 'n', objective: 'o' }, telemetry, gitInfo);
  assert.equal(start.pullRequests, undefined);
  const none = hook.enrichToolInput('mcp__waypoint__waypoint_checkpoint_run', { projectId: 'p', runId: 'r' }, telemetry, { branch: 'wp-0766-x' });
  assert.equal(none.pullRequests, undefined);
});

test('mergePullRequests keeps first-seen order, lets the newer report win, drops entries without a url, caps', () => {
  const merged = hook.mergePullRequests([{ url: 'https://a/1', state: 'open' }, { bogus: true }], [{ url: 'https://a/1', state: 'merged', number: 1 }, { url: 'https://a/2' }], 20);
  assert.deepEqual(merged, [{ url: 'https://a/1', state: 'merged', number: 1 }, { url: 'https://a/2' }]);
  assert.equal(hook.mergePullRequests([], Array.from({ length: 25 }, (_, i) => ({ url: `https://a/${i}` })), 20).length, 20);
});

test('collectPullRequest stays quiet on the trunk and when no forge CLI answers', () => {
  assert.equal(hook.collectPullRequest(process.cwd(), 'main'), undefined);
  assert.equal(hook.collectPullRequest(process.cwd(), undefined), undefined);
});
