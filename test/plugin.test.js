'use strict';
// Run with: node --test test/
// The hook is tested the way it runs — as a child process reading a harness payload —
// against a real temporary git repository. No dependencies.
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const HOOK = path.join(ROOT, 'scripts', 'waypoint-hook.js');
const INSTALL = path.join(ROOT, 'scripts', 'install.js');
const hook = require(HOOK);

function runHook(payload, args = [], env = {}) {
  const stdout = execFileSync(process.execPath, [HOOK, ...args], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  return stdout.trim() ? JSON.parse(stdout) : undefined;
}

function git(cwd, ...args) { return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); }

function makeRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'waypoint-hook-'));
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'hook@test');
  git(repo, 'config', 'user.name', 'hook');
  fs.writeFileSync(path.join(repo, 'base.txt'), 'base');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'base');
  git(repo, 'checkout', '-q', '-b', 'feature/x');
  fs.writeFileSync(path.join(repo, 'changed.ts'), 'x');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'feature commit');
  fs.writeFileSync(path.join(repo, 'dirty.ts'), 'y');
  return repo;
}

const telemetry = { agent: { harness: 'claude-code', model: 'claude-opus-5', host: 'dev-box' } };

test('matches the three run tools under every harness prefix and nothing else', () => {
  assert.equal(hook.matchedTool('mcp__waypoint__waypoint_start_run'), 'waypoint_start_run');
  assert.equal(hook.matchedTool('mcp__plugin_waypoint_waypoint__waypoint_checkpoint_run'), 'waypoint_checkpoint_run');
  assert.equal(hook.matchedTool('waypoint_complete_run'), 'waypoint_complete_run');
  assert.equal(hook.matchedTool('mcp__waypoint__waypoint_get_work'), undefined);
  assert.equal(hook.matchedTool('Bash'), undefined);
});

test('start_run gains telemetry, branch and repository without overriding what the model sent', () => {
  const gitInfo = { branch: 'claude/feature', repositoryUrl: 'https://github.com/nldlabs/waypoint.git', files: ['a.ts'], commits: ['abc fix'] };
  const out = hook.enrichToolInput('mcp__waypoint__waypoint_start_run', { projectId: 'p', name: 'n', objective: 'o', branch: 'keep-me' }, telemetry, gitInfo);
  assert.deepEqual(out.agent, telemetry.agent);
  assert.equal(out.branch, 'keep-me');
  assert.equal(out.repositoryUrl, gitInfo.repositoryUrl);
  assert.equal(out.files, undefined);
});

test('checkpoint and complete union git-changed files and unpushed commits with what the model listed', () => {
  const gitInfo = { files: ['lambda/mcp.ts', 'plugin/README.md'], commits: ['abc1234 Add plugin'] };
  const checkpoint = hook.enrichToolInput('mcp__waypoint__waypoint_checkpoint_run', { projectId: 'p', runId: 'r', files: ['lambda/mcp.ts', 'docs/x.md'] }, telemetry, gitInfo);
  assert.deepEqual(checkpoint.files, ['lambda/mcp.ts', 'docs/x.md', 'plugin/README.md']);
  assert.deepEqual(checkpoint.commits, ['abc1234 Add plugin']);
  const complete = hook.enrichToolInput('mcp__waypoint__waypoint_complete_run', { projectId: 'p', runId: 'r', status: 'completed' }, telemetry, gitInfo);
  assert.deepEqual(complete.files, gitInfo.files);
  assert.equal(complete.status, 'completed');
});

test('model-supplied agent fields win over detected ones; caps hold; harness detection', () => {
  const out = hook.enrichToolInput('waypoint_start_run', { agent: { model: 'operator-pinned' } }, telemetry, {});
  assert.equal(out.agent.model, 'operator-pinned');
  assert.equal(out.agent.harness, 'claude-code');
  assert.equal(hook.union(undefined, Array.from({ length: 500 }, (_, i) => `f${i}`), 200, 500).length, 200);
  assert.equal(hook.detectHarness({}, { WAYPOINT_HARNESS: 'custom' }), 'custom');
  assert.equal(hook.detectHarness({ toolName: 'x' }, {}), 'copilot-cli');
  assert.equal(hook.detectHarness({}, { CLAUDECODE: '1' }), 'claude-code');
  assert.equal(hook.detectHarness({}, { CODEX_HOME: '/x' }), 'codex');
  assert.equal(hook.detectHarness({}, {}), 'unknown');
  // WP-0720: Codex stamps turn_id on every payload and aliases CLAUDE_PLUGIN_ROOT for
  // Claude-format plugins; neither the alias nor a Claude variable inherited from the
  // terminal that launched Codex may turn a Codex session into "claude-code".
  assert.equal(hook.detectHarness({ tool_name: 'x', turn_id: 't1' }, { CLAUDECODE: '1', CLAUDE_PLUGIN_ROOT: '/p', PLUGIN_ROOT: '/p' }), 'codex');
  assert.equal(hook.detectHarness({ tool_name: 'x' }, { CLAUDE_PLUGIN_ROOT: '/p', PLUGIN_ROOT: '/p' }), 'unknown');
  assert.equal(hook.detectHarness({ tool_name: 'x' }, { CLAUDE_PLUGIN_ROOT: '/p' }), 'claude-code');
});

test('claimOnce lets exactly one hook process handle a tool call when two hook sources fire (WP-0720)', () => {
  const payload = { session_id: `once-${process.pid}-${Date.now()}`, tool_use_id: 'call_1' };
  assert.equal(hook.claimOnce(payload, 'pretooluse'), true);
  assert.equal(hook.claimOnce(payload, 'pretooluse'), false);
  assert.equal(hook.claimOnce(payload, 'posttooluse'), true, 'a different event of the same call is its own claim');
  assert.equal(hook.claimOnce({ session_id: payload.session_id }, 'pretooluse'), true, 'no tool_use_id: never deduplicated');
});

test('as a child process against a real git repo', async (t) => {
  const repo = makeRepo();
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));

  await t.test('Claude/Codex payload: updatedInput with telemetry, model from transcript, git evidence', () => {
    const transcript = path.join(repo, 'transcript.jsonl');
    fs.writeFileSync(transcript, [
      JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-4' } }),
      JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-5' } }),
    ].join('\n'));
    const out = runHook({
      hook_event_name: 'PreToolUse',
      tool_name: 'mcp__waypoint__waypoint_checkpoint_run',
      tool_input: { projectId: 'p', runId: 'r', checkpoints: ['did a thing'] },
      cwd: repo,
      transcript_path: transcript,
    }, ['--harness', 'claude-code']);
    const specific = out.hookSpecificOutput;
    assert.equal(specific.hookEventName, 'PreToolUse');
    assert.equal(specific.permissionDecision, 'allow');
    const input = specific.updatedInput;
    assert.deepEqual(input.checkpoints, ['did a thing']);
    assert.equal(input.agent.harness, 'claude-code');
    assert.equal(input.agent.model, 'claude-opus-5');
    assert.ok(input.agent.host);
    assert.match(input.agent.plugin, /^waypoint-plugin/);
    assert.ok(input.files.includes('dirty.ts') && input.files.includes('changed.ts'));
    assert.ok(input.commits.some((c) => c.endsWith('feature commit')));
    assert.ok(!input.commits.some((c) => c.endsWith(' base')));
  });

  await t.test('start_run fills branch from git and the model from the Codex payload', () => {
    const out = runHook({
      hook_event_name: 'PreToolUse',
      tool_name: 'mcp__waypoint__waypoint_start_run',
      tool_input: { projectId: 'p', name: 'n', objective: 'o' },
      cwd: repo,
      model: 'gpt-5-codex',
    }, ['--harness', 'codex']);
    const input = out.hookSpecificOutput.updatedInput;
    assert.equal(input.branch, 'feature/x');
    assert.equal(input.agent.harness, 'codex');
    assert.equal(input.agent.model, 'gpt-5-codex');
    assert.equal(input.files, undefined);
  });

  await t.test('WAYPOINT_HOOK_DECISION=ask keeps the permission prompt', () => {
    const out = runHook({ hook_event_name: 'PreToolUse', tool_name: 'mcp__waypoint__waypoint_start_run', tool_input: { projectId: 'p' }, cwd: repo }, [], { WAYPOINT_HOOK_DECISION: 'ask' });
    assert.equal(out.hookSpecificOutput.permissionDecision, 'ask');
  });

  await t.test('Copilot CLI payload: modifiedArgs', () => {
    const out = runHook({ toolName: 'waypoint_complete_run', toolArgs: { projectId: 'p', runId: 'r', status: 'completed' }, cwd: repo, sessionId: 's1' });
    assert.equal(out.hookSpecificOutput, undefined);
    assert.equal(out.modifiedArgs.status, 'completed');
    assert.equal(out.modifiedArgs.agent.harness, 'copilot-cli');
    assert.ok(out.modifiedArgs.files.includes('dirty.ts'));
  });

  await t.test('other tools, other events and garbage input produce no output and exit 0', () => {
    assert.equal(runHook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, cwd: repo }), undefined);
    assert.equal(runHook({ hook_event_name: 'PostToolUse', tool_name: 'mcp__waypoint__waypoint_start_run', cwd: repo }), undefined);
    assert.equal(execFileSync(process.execPath, [HOOK], { input: 'not json', encoding: 'utf8' }), '');
  });

  await t.test('SessionStart remembers the model for later calls and emits one line of context', () => {
    const session = `hook-test-${process.pid}-${Date.now()}`;
    const start = runHook({ hook_event_name: 'SessionStart', session_id: session, model: 'claude-sonnet-5', cwd: repo }, ['--harness', 'claude-code']);
    assert.equal(start.hookSpecificOutput.hookEventName, 'SessionStart');
    assert.match(start.hookSpecificOutput.additionalContext, /claude-sonnet-5/);
    assert.ok(start.hookSpecificOutput.additionalContext.length < 400);
    const later = runHook({ hook_event_name: 'PreToolUse', session_id: session, tool_name: 'mcp__waypoint__waypoint_start_run', tool_input: { projectId: 'p' }, cwd: repo }, ['--harness', 'claude-code']);
    assert.equal(later.hookSpecificOutput.updatedInput.agent.model, 'claude-sonnet-5');
  });

  await t.test('--event collect prints telemetry', () => {
    const out = runHook({ cwd: repo }, ['--event', 'collect', '--harness', 'copilot-vscode']);
    assert.equal(out.harness, 'copilot-vscode');
    assert.equal(out.git.branch, 'feature/x');
  });
});

test('manifests: plugin and marketplace agree; the plugin is hooks-only (MCP comes from claude mcp add)', () => {
  const marketplace = JSON.parse(fs.readFileSync(path.join(ROOT, '.claude-plugin', 'marketplace.json'), 'utf8'));
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, '.claude-plugin', 'plugin.json'), 'utf8'));
  assert.equal(marketplace.name, 'waypoint');
  assert.equal(typeof marketplace.owner, 'object');
  const entry = marketplace.plugins.find((plugin) => plugin.name === 'waypoint');
  assert.equal(entry.source, './');
  assert.equal(manifest.name, 'waypoint');
  assert.equal(manifest.version, entry.version, 'bump plugin.json and marketplace.json together');
  // No MCP server and no userConfig: this Claude Code build has no settings dialog, so the
  // server is added with `claude mcp add` and the hook matcher covers mcp__waypoint__*.
  assert.ok(!fs.existsSync(path.join(ROOT, '.mcp.json')));
  assert.equal(manifest.userConfig, undefined);
  assert.equal(manifest.mcpServers, undefined); assert.equal(manifest.hooks, undefined);
  const hooks = fs.readFileSync(path.join(ROOT, 'hooks', 'hooks.json'), 'utf8');
  assert.ok(hooks.includes('mcp__(plugin_waypoint_)?waypoint__waypoint_(start_run|checkpoint_run|complete_run)'));
  assert.ok(hooks.includes(''));
});

test('installer writes per-harness files, never a token, and merges on re-run', async (t) => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'waypoint-install-'));
  // An isolated home: the codex target now reads (and may patch) ~/.codex/config.toml.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'waypoint-install-home-'));
  t.after(() => { fs.rmSync(repo, { recursive: true, force: true }); fs.rmSync(home, { recursive: true, force: true }); });
  const run = (args) => execFileSync(process.execPath, [INSTALL, ...args, '--dir', repo, '--home', home, '--url', 'https://api.example.test/mcp'], { encoding: 'utf8' });

  const first = run(['all']);
  for (const line of ['create: .codex/hooks.json', 'create: .github/hooks/waypoint.json', 'create: .vscode/mcp.json', 'create: .claude/settings.json', 'bearer_token_env_var = "WAYPOINT_TOKEN"', 'waypoint-plugin']) {
    assert.ok(first.includes(line), line);
  }
  const copilot = JSON.parse(fs.readFileSync(path.join(repo, '.github', 'hooks', 'waypoint.json'), 'utf8'));
  assert.equal(copilot.version, 1);
  assert.ok(copilot.hooks.preToolUse[0].powershell.includes('--harness copilot-cli'));
  const vscode = JSON.parse(fs.readFileSync(path.join(repo, '.vscode', 'mcp.json'), 'utf8'));
  assert.equal(vscode.servers.waypoint.headers.Authorization, 'Bearer ${input:waypoint-token}');
  assert.equal(vscode.inputs[0].password, true);
  const codex = JSON.parse(fs.readFileSync(path.join(repo, '.codex', 'hooks.json'), 'utf8'));
  assert.ok(codex.hooks.PreToolUse[0].hooks[0].command.includes(HOOK.replace(/\\/g, '/')));

  const settingsPath = path.join(repo, '.claude', 'settings.json');
  fs.writeFileSync(settingsPath, JSON.stringify({ permissions: { allow: ['Bash'] }, hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [] }] } }));
  assert.ok(run(['vscode']).includes('merge: .claude/settings.json'));
  run(['vscode']);
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  assert.deepEqual(settings.permissions.allow, ['Bash']);
  // The operator's own 'Bash' entry plus the plugin's two PreToolUse entries (run telemetry, decision wait).
  assert.equal(settings.hooks.PreToolUse.length, 3);

  for (const file of ['.codex/hooks.json', '.github/hooks/waypoint.json', '.vscode/mcp.json', '.claude/settings.json']) {
    assert.doesNotMatch(fs.readFileSync(path.join(repo, file), 'utf8'), /Bearer [A-Za-z0-9]{20,}/);
  }
  assert.ok(run(['copilot', '--dry-run']).includes('[dry-run]'));
});

test('--token makes codex and copilot one-command: user-level MCP config is written and re-runs are safe', async (t) => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'waypoint-token-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'waypoint-home-'));
  t.after(() => { fs.rmSync(repo, { recursive: true, force: true }); fs.rmSync(home, { recursive: true, force: true }); });
  const run = (args) => execFileSync(process.execPath, [INSTALL, ...args, '--dir', repo, '--home', home, '--url', 'https://api.example.test/mcp', '--token', 'tok_secret_123'], { encoding: 'utf8' });

  const first = run(['codex', 'copilot', 'claude']);
  assert.ok(first.includes('Nothing else to do'));
  assert.ok(first.includes('claude mcp add --transport http --scope user waypoint https://api.example.test/mcp --header "Authorization: Bearer tok_secret_123"'));

  const toml = fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8');
  assert.ok(toml.includes('[mcp_servers.waypoint]'));
  assert.ok(toml.includes('url = "https://api.example.test/mcp"'));
  assert.ok(toml.includes('"Authorization" = "Bearer tok_secret_123"'));
  // WP-0720: every Waypoint tool is pre-approved so Codex's reviewer never sees the idle poll.
  assert.ok(toml.includes('[mcp_servers.waypoint.tools.waypoint_await_work]\napproval_mode = "approve"'));
  assert.equal((toml.match(/approval_mode = "approve"/g) || []).length, 21);

  const copilot = JSON.parse(fs.readFileSync(path.join(home, '.copilot', 'mcp-config.json'), 'utf8'));
  assert.equal(copilot.mcpServers.waypoint.url, 'https://api.example.test/mcp');
  assert.equal(copilot.mcpServers.waypoint.headers.Authorization, 'Bearer tok_secret_123');

  // Re-run: the TOML block is not duplicated, the JSON merges, other servers survive.
  fs.writeFileSync(path.join(home, '.copilot', 'mcp-config.json'), JSON.stringify({ mcpServers: { other: { type: 'http', url: 'https://other' }, waypoint: { stale: true } } }));
  const second = run(['codex', 'copilot']);
  assert.ok(second.includes('skip ([mcp_servers.waypoint] already present)'));
  assert.ok(second.includes('skip (all Waypoint tools already have an approval_mode)'));
  assert.equal((fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8').match(/\[mcp_servers\.waypoint\]/g) || []).length, 1);
  // A hand-written config with the server but only some tools approved gets the rest, once.
  fs.writeFileSync(path.join(home, '.codex', 'config.toml'), '[mcp_servers.waypoint]\nurl = "https://api.example.test/mcp"\n\n[mcp_servers.waypoint.tools.waypoint_await_decision]\napproval_mode = "prompt"\n');
  const third = run(['codex']);
  assert.ok(third.includes('approve 20 tools'), third);
  const patched = fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8');
  assert.equal((patched.match(/\[mcp_servers\.waypoint\.tools\.waypoint_await_decision\]/g) || []).length, 1, 'the user\'s own table is left alone');
  assert.ok(patched.includes('[mcp_servers.waypoint.tools.waypoint_await_work]\napproval_mode = "approve"'));
  assert.ok(run(['codex']).includes('skip (all Waypoint tools already have an approval_mode)'));
  const merged = JSON.parse(fs.readFileSync(path.join(home, '.copilot', 'mcp-config.json'), 'utf8'));
  assert.equal(merged.mcpServers.other.url, 'https://other');
  assert.equal(merged.mcpServers.waypoint.headers.Authorization, 'Bearer tok_secret_123');
  assert.equal(merged.mcpServers.waypoint.stale, undefined);
});
