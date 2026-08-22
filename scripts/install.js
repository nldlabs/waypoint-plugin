#!/usr/bin/env node
'use strict';
/**
 * Writes the Waypoint plugin's configuration into a repository for one or more
 * agent harnesses. Idempotent: existing files are merged (JSON) or left alone
 * (use --force to overwrite), and nothing secret is ever written — tokens stay
 * in environment variables or prompted inputs.
 *
 *   node plugin/scripts/install.js <claude|codex|copilot|vscode|all> [options]
 *
 * Options:
 *   --url <mcp url>         Waypoint MCP endpoint, e.g. https://api.example.com/mcp
 *                           (default: $WAYPOINT_MCP_URL)
 *   --token <value>         Agent token. When given, the user-level MCP config is
 *                           written too (~/.codex/config.toml, ~/.copilot/mcp-config.json)
 *                           so the install is one command with no manual editing.
 *   --token-env <NAME>      Without --token: the env var that will hold the token (default WAYPOINT_TOKEN)
 *   --dir <repo root>       Repository to write into (default: current directory)
 *   --force                 Overwrite files this installer owns outright
 *   --dry-run               Print what would be written and exit
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const PLUGIN_ROOT = path.resolve(__dirname, '..');
const HOOK_SCRIPT = path.join(PLUGIN_ROOT, 'scripts', 'waypoint-hook.js');
const TEMPLATES = path.join(PLUGIN_ROOT, 'templates');
const HARNESSES = ['claude', 'codex', 'copilot', 'vscode'];

function parseArgs(argv) {
  const options = {
    targets: [],
    url: process.env.WAYPOINT_MCP_URL || '',
    token: '',
    tokenEnv: 'WAYPOINT_TOKEN',
    dir: process.cwd(),
    home: os.homedir(),
    force: false,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--url') options.url = argv[++i] || '';
    else if (arg === '--token') options.token = argv[++i] || '';
    else if (arg === '--home') options.home = path.resolve(argv[++i] || options.home);
    else if (arg === '--token-env') options.tokenEnv = argv[++i] || options.tokenEnv;
    else if (arg === '--dir') options.dir = path.resolve(argv[++i] || '.');
    else if (arg === '--force') options.force = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === 'all') options.targets.push(...HARNESSES);
    else if (HARNESSES.includes(arg)) options.targets.push(arg);
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  options.targets = [...new Set(options.targets)];
  return options;
}

function usage() {
  return fs.readFileSync(__filename, 'utf8').split('\n').slice(2, 22).map((line) => line.replace(/^ \*\s?/, '')).join('\n');
}

// Append a TOML table to ~/.codex/config.toml unless a [mcp_servers.waypoint]
// table is already there — TOML has no safe generic merge, so present wins.
function appendCodexConfig(options, url) {
  const file = path.join(options.home, '.codex', 'config.toml');
  const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  if (current.includes('[mcp_servers.waypoint]')) {
    return { file, action: 'skip ([mcp_servers.waypoint] already present)' };
  }
  const block = `\n[mcp_servers.waypoint]\nurl = ${JSON.stringify(url)}\nhttp_headers = { "Authorization" = ${JSON.stringify(`Bearer ${options.token}`)} }\n`;
  if (!options.dryRun) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, block);
  }
  return { file, action: current ? 'append' : 'create' };
}

// Paths in generated config are relative to the repo root where that is
// portable (committed files), absolute where the harness gives no working
// directory guarantee (user-level config). Forward slashes everywhere: every
// harness here tolerates them on Windows and they survive JSON unescaped.
function toPosix(p) { return p.replace(/\\/g, '/'); }
function relativeHook(dir) {
  const rel = path.relative(dir, HOOK_SCRIPT);
  return rel.startsWith('..') ? toPosix(HOOK_SCRIPT) : `./${toPosix(rel)}`;
}

function render(templateName, vars) {
  let text = fs.readFileSync(path.join(TEMPLATES, templateName), 'utf8');
  for (const [key, value] of Object.entries(vars)) text = text.split(key).join(value);
  return text;
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return undefined; }
}

function writeFile(file, content, options, { mergeJson } = {}) {
  const exists = fs.existsSync(file);
  let final = content;
  let action = exists ? 'overwrite' : 'create';
  if (exists && !options.force) {
    if (mergeJson) {
      const current = readJson(file);
      if (!current) throw new Error(`${file} exists and is not valid JSON; fix it or pass --force`);
      final = JSON.stringify(mergeJson(current, JSON.parse(content)), null, 2) + '\n';
      action = 'merge';
    } else {
      return { file, action: 'skip (exists; --force to overwrite)' };
    }
  }
  if (!options.dryRun) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, final);
  }
  return { file, action };
}

// Merge hook entries without duplicating ones that point at our script.
function mergeHooks(current, incoming) {
  const out = { ...current, hooks: { ...(current.hooks || {}) } };
  for (const [event, entries] of Object.entries(incoming.hooks || {})) {
    const existing = Array.isArray(out.hooks[event]) ? out.hooks[event] : [];
    const isOurs = (entry) => JSON.stringify(entry).includes('waypoint-hook.js');
    out.hooks[event] = [...existing.filter((entry) => !isOurs(entry)), ...entries];
  }
  return out;
}

function mergeServers(key) {
  return (current, incoming) => {
    const out = { ...current };
    out[key] = { ...(current[key] || {}), ...(incoming[key] || {}) };
    if (incoming.inputs) {
      const existing = Array.isArray(current.inputs) ? current.inputs : [];
      const ids = new Set(incoming.inputs.map((input) => input.id));
      out.inputs = [...existing.filter((input) => !ids.has(input.id)), ...incoming.inputs];
    }
    return out;
  };
}

function install(options) {
  const results = [];
  const notes = [];
  const url = options.url || '<WAYPOINT_MCP_URL>';
  const vars = {
    __WAYPOINT_HOOK__: relativeHook(options.dir),
    __WAYPOINT_HOOK_ABS__: toPosix(HOOK_SCRIPT),
    __WAYPOINT_MCP_URL__: url,
    __WAYPOINT_TOKEN_ENV__: options.tokenEnv,
  };
  const at = (...segments) => path.join(options.dir, ...segments);

  for (const target of options.targets) {
    if (target === 'claude') {
      // Claude Code loads the plugin directory directly; nothing to write.
      const header = options.token ? ` --header ${JSON.stringify(`Authorization: Bearer ${options.token}`)}` : '';
      notes.push(
        `Claude Code: one command does everything (MCP server + plugin):\n` +
        `    claude mcp add --transport http --scope user waypoint ${url}${header} && claude plugin marketplace add nldlabs/waypoint-plugin && claude plugin install waypoint@waypoint --scope user\n` +
        `  or for one session only: claude --plugin-dir ${toPosix(PLUGIN_ROOT)}`
      );
    }
    if (target === 'codex') {
      results.push(writeFile(at('.codex', 'hooks.json'), render('codex-hooks.json', { ...vars, __WAYPOINT_HOOK__: vars.__WAYPOINT_HOOK_ABS__ }), options, { mergeJson: mergeHooks }));
      if (options.token) {
        results.push(appendCodexConfig(options, url));
        notes.push('Codex: server written to ~/.codex/config.toml, hooks to .codex/hooks.json. Nothing else to do.');
      } else {
        notes.push(
          `Codex: add this to ~/.codex/config.toml (or ${toPosix(at('.codex', 'config.toml'))}) and export ${options.tokenEnv}:\n\n` +
          render('codex-config.toml', vars).split('\n').filter((line) => !line.startsWith('#') && line.trim()).map((line) => `    ${line}`).join('\n') +
          `\n  Hooks were written to .codex/hooks.json (hooks are on by default in current Codex; \`[features] hooks = true\` enables them if yours are off).`
        );
      }
    }
    if (target === 'copilot') {
      results.push(writeFile(at('.github', 'hooks', 'waypoint.json'), render('copilot-hooks.json', vars), options, { mergeJson: mergeHooks }));
      if (options.token) {
        const server = { mcpServers: { waypoint: { type: 'http', url, headers: { Authorization: `Bearer ${options.token}` }, tools: ['*'] } } };
        results.push(writeFile(path.join(options.home, '.copilot', 'mcp-config.json'), JSON.stringify(server, null, 2) + '\n', options, { mergeJson: mergeServers('mcpServers') }));
        notes.push('Copilot: server written to ~/.copilot/mcp-config.json, hooks to .github/hooks/waypoint.json. Nothing else to do.');
      } else {
        notes.push(
          `Copilot CLI: add the server to ~/.copilot/mcp-config.json (export ${options.tokenEnv} first):\n\n` +
          render('copilot-mcp-config.json', vars).split('\n').map((line) => `    ${line}`).join('\n') +
          `\n  Hooks were written to .github/hooks/waypoint.json; Copilot CLI and the Copilot cloud agent load hooks from there.`
        );
      }
    }
    if (target === 'vscode') {
      results.push(writeFile(at('.vscode', 'mcp.json'), render('vscode-mcp.json', vars), options, { mergeJson: mergeServers('servers') }));
      results.push(writeFile(at('.claude', 'settings.json'), render('claude-settings-hooks.json', vars), options, { mergeJson: mergeHooks }));
      notes.push(
        `VS Code (Copilot agent mode): .vscode/mcp.json prompts for the token the first time the server starts;\n` +
        `  hooks were merged into .claude/settings.json, which VS Code reads alongside .github/hooks.`
      );
    }
  }
  return { results, notes };
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    console.error(usage());
    process.exit(2);
  }
  if (options.help || options.targets.length === 0) {
    console.log(usage());
    process.exit(options.help ? 0 : 2);
  }
  if (!options.url) {
    console.error('No MCP URL: pass --url https://…/mcp or set WAYPOINT_MCP_URL (Connect agent in the dashboard shows it).');
  }
  const { results, notes } = install(options);
  for (const result of results) {
    const rel = path.relative(options.dir, result.file);
    const shown = !rel || rel.startsWith('..') ? toPosix(result.file) : toPosix(rel);
    console.log(`${options.dryRun ? '[dry-run] ' : ''}${result.action}: ${shown}`);
  }
  if (notes.length) console.log('\nNext steps\n' + notes.map((note) => `- ${note}`).join('\n\n'));
}

if (require.main === module) main();
else module.exports = { install, parseArgs, mergeHooks, mergeServers };
