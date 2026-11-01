#!/usr/bin/env node
// batcave: install Batcave into any coding agent, and use the team board from any shell.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { INSTALLERS, writeAgentsMd } from './installers.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN = path.join(ROOT, 'plugin');
const HOME_DIR = process.env.BATCAVE_HOME || path.join(os.homedir(), '.batcave');
const RUNTIME = path.join(HOME_DIR, 'runtime');

const argv = process.argv.slice(2);
const cmd = argv[0];
const flags = {};
const rest = [];
for (let i = 1; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) {
    const k = a.slice(2); const n = argv[i + 1];
    if (n === undefined || n.startsWith('--')) flags[k] = true; else { flags[k] = n; i++; }
  } else rest.push(a);
}

const out = (s = '') => process.stdout.write(s + '\n');
const die = (s) => { process.stderr.write(`✗ ${s}\n`); process.exit(1); };

function copyRuntime() {
  fs.mkdirSync(RUNTIME, { recursive: true });
  for (const d of ['lib', 'hooks', 'mcp', 'scripts', 'commands']) {
    fs.rmSync(path.join(RUNTIME, d), { recursive: true, force: true });
    fs.cpSync(path.join(PLUGIN, d), path.join(RUNTIME, d), { recursive: true });
  }
  return RUNTIME;
}

function pickAgents(spec) {
  const names = Object.keys(INSTALLERS);
  if (!spec || spec === true || spec === 'auto') return names.filter((n) => { try { return INSTALLERS[n].detect(); } catch { return false; } });
  if (spec === 'all') return names;
  const list = String(spec).split(',').map((s) => s.trim().toLowerCase()).map((s) => (s === 'antigravity' ? 'gemini' : s));
  for (const n of list) if (!INSTALLERS[n]) die(`Unknown agent "${n}". Supported: ${names.join(', ')}`);
  return [...new Set(list)];
}

async function tools() {
  return (await import(pathToFileURL(path.join(PLUGIN, 'lib', 'tools.mjs')).href)).tools;
}

async function run(name, args) {
  const t = (await tools())[name];
  try { out(await t.run(args)); } catch (e) { die(e.message); }
}

const HELP = `batcave: multiplayer coding agents

Setup
  batcave init [--agent auto|all|claude,codex,gemini,cursor,copilot,opencode,kiro,windsurf]
               [--url URL --token TOKEN --user HANDLE --name NAME] [--repo]
      Connect this machine to your team and wire Batcave into your agents.
      --agent defaults to every agent found on this machine.
      --repo also adds a Batcave section to ./AGENTS.md.
  batcave uninstall [--agent ...]    Remove Batcave from agents (backups are kept)
  batcave agents                     Show supported agents and which are installed here
  batcave doctor                     Check config and server
  batcave server [--port 4777]       Run a Batcave server (needs BATCAVE_TEAM_TOKEN)

Team (works from any shell, no agent needed)
  batcave board [--mine]             batcave people
  batcave task <title>               batcave claim <id> [--force]
  batcave release <id>               batcave status <id> <backlog|claimed|running|review|done>
  batcave room [room]                batcave say <message>
  batcave decide <decision>          batcave decisions
  batcave ask <handle> <request>     batcave requests [--sent]
  batcave accept <id>                batcave decline <id>
  batcave handoff <id> <handle> <summary>
  batcave pickup <id>                batcave pulse [hours]
  batcave whoami                     batcave line   (one-line status)
`;

switch (cmd) {
  case undefined: case 'help': case '--help': case '-h':
    out(HELP); break;

  case 'init': {
    const rt = copyRuntime();
    out(`✓ Runtime installed at ${rt}`);
    const cfgFile = path.join(HOME_DIR, 'config.json');
    const setupArgs = ['url', 'token', 'user', 'name'].flatMap((k) => (flags[k] ? [`--${k}`, String(flags[k])] : []));
    if (setupArgs.length || !fs.existsSync(cfgFile)) {
      if (!flags.url && !fs.existsSync(cfgFile)) die('First run needs --url, --token, --user and --name (ask your team admin for the URL and token).');
      const r = spawnSync(process.execPath, [path.join(rt, 'scripts', 'setup.mjs'), ...setupArgs], { stdio: 'inherit' });
      if (r.status !== 0) process.exit(r.status || 1);
    } else out(`✓ Using existing config ${cfgFile}`);

    const agents = pickAgents(flags.agent);
    if (!agents.length) out('\n! No coding agents found on this machine. Use --agent to choose one, e.g. --agent codex.');
    out('');
    for (const name of agents) {
      const inst = INSTALLERS[name];
      try {
        const r = inst.install(rt);
        out(`✓ ${inst.label}${inst.level === 'tools' ? '  (tools only: no automatic presence or guard yet)' : ''}`);
        for (const w of r.wrote || []) out(`    ${w}`);
        for (const m of r.manual || []) out(`    ${m}`);
      } catch (e) { out(`✗ ${inst.label}: ${e.message}`); }
    }
    if (flags.repo) out(`\n✓ Added Batcave instructions to ${writeAgentsMd(process.cwd())}`);
    out('\nRestart your agents so they load the new hooks and MCP server.');
    break;
  }

  case 'uninstall': {
    const agents = flags.agent ? pickAgents(flags.agent) : Object.keys(INSTALLERS);
    for (const name of agents) {
      const inst = INSTALLERS[name];
      try {
        const r = inst.uninstall();
        out(`✓ ${inst.label}`);
        for (const m of r.manual || []) out(`    ${m}`);
      } catch (e) { out(`✗ ${inst.label}: ${e.message}`); }
    }
    break;
  }

  case 'agents': {
    out('Agent                      Support          Found here');
    for (const [, inst] of Object.entries(INSTALLERS)) {
      let found = false; try { found = inst.detect(); } catch {}
      out(`${inst.label.padEnd(27)}${(inst.level === 'full' ? 'full' : 'tools only').padEnd(17)}${found ? 'yes' : '-'}`);
    }
    break;
  }

  case 'doctor': {
    const r = spawnSync(process.execPath, [path.join(PLUGIN, 'scripts', 'doctor.mjs')], { stdio: 'inherit' });
    process.exit(r.status || 0);
  }

  case 'server': {
    const env = { ...process.env, ...(flags.port ? { PORT: String(flags.port) } : {}) };
    spawnSync(process.execPath, [path.join(ROOT, 'server', 'src', 'index.mjs')], { stdio: 'inherit', env });
    break;
  }

  case 'line': {
    const r = spawnSync(process.execPath, [path.join(PLUGIN, 'scripts', 'statusline.mjs')], { input: '{}', encoding: 'utf8' });
    out(r.stdout || '○ batcave not set up'); break;
  }

  case 'board': await run('batcave_board', { mine: Boolean(flags.mine) }); break;
  case 'people': await run('batcave_people', {}); break;
  case 'whoami': await run('batcave_whoami', {}); break;
  case 'task': if (!rest.length) die('Usage: batcave task <title>'); await run('batcave_task_create', { title: rest.join(' '), source: 'cli' }); break;
  case 'claim': if (!rest[0]) die('Usage: batcave claim <id>'); await run('batcave_claim', { task: rest[0], force: Boolean(flags.force) }); break;
  case 'release': if (!rest[0]) die('Usage: batcave release <id>'); await run('batcave_release', { task: rest[0] }); break;
  case 'status': if (rest.length < 2) die('Usage: batcave status <id> <status>'); await run('batcave_task_status', { task: rest[0], status: rest[1] }); break;
  case 'room': await run('batcave_room_read', { room: rest[0] }); break;
  case 'say': if (!rest.length) die('Usage: batcave say <message>'); await run('batcave_say', { text: rest.join(' ') }); break;
  case 'decide': if (!rest.length) die('Usage: batcave decide <decision>'); await run('batcave_decide', { text: rest.join(' ') }); break;
  case 'decisions': await run('batcave_decisions', {}); break;
  case 'ask': if (rest.length < 2) die('Usage: batcave ask <handle> <request>'); await run('batcave_request', { to: rest[0], text: rest.slice(1).join(' ') }); break;
  case 'requests': await run('batcave_requests', { box: flags.sent ? 'sent' : 'inbox' }); break;
  case 'accept': if (!rest[0]) die('Usage: batcave accept <id>'); await run('batcave_request_resolve', { id: rest[0], action: 'accept' }); break;
  case 'decline': if (!rest[0]) die('Usage: batcave decline <id>'); await run('batcave_request_resolve', { id: rest[0], action: 'decline' }); break;
  case 'handoff': if (rest.length < 3) die('Usage: batcave handoff <id> <handle> <summary>'); await run('batcave_handoff', { task: rest[0], to: rest[1], summary: rest.slice(2).join(' ') }); break;
  case 'pickup': if (!rest[0]) die('Usage: batcave pickup <id>'); await run('batcave_pickup', { id: rest[0] }); break;
  case 'pulse': await run('batcave_pulse', { hours: Number(rest[0]) || 24 }); break;

  default: die(`Unknown command "${cmd}". Run batcave help.`);
}
