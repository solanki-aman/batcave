#!/usr/bin/env node
// batcave: install Batcave into any coding agent, and use the team board from any shell.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
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


// ---------- alfred (local Julia-1 decision model) ----------
const ALFRED_DIR = path.join(HOME_DIR, 'alfred');
const ALFRED_VENV = path.join(ALFRED_DIR, 'venv');
const ALFRED_MODEL = path.join(ALFRED_DIR, 'Julia-1');
const venvPy = () => path.join(ALFRED_VENV, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');

function sh(cmd, args, opts = {}) {
  out(`  $ ${[cmd, ...args].join(' ')}`);
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (r.status !== 0) die(`Command failed: ${cmd} ${args.join(' ')}`);
}

function findPython() {
  for (const c of ['python3', 'python']) {
    const r = spawnSync(c, ['-c', 'import sys;print(sys.version_info[:2] >= (3,9))'], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout.trim() === 'True') return c;
  }
  die('Python 3.9+ is required for Alfred. Install it and re-run.');
}

function alfredInstall() {
  const py = findPython();
  fs.mkdirSync(ALFRED_DIR, { recursive: true });
  out('Setting up the Batcave alfred (Julia-1, Apache-2.0, ~580 MB) in ' + ALFRED_DIR);
  if (!fs.existsSync(venvPy())) sh(py, ['-m', 'venv', ALFRED_VENV]);
  sh(venvPy(), ['-m', 'pip', 'install', '--quiet', '--upgrade', 'pip', 'huggingface_hub']);
  if (process.platform === 'linux' && !flags['keep-torch']) {
    sh(venvPy(), ['-m', 'pip', 'install', '--quiet', 'torch', '--index-url', 'https://download.pytorch.org/whl/cpu']);
  }
  sh(venvPy(), ['-c', `from huggingface_hub import snapshot_download; snapshot_download('${flags.repo || 'SupersonicLabs/Julia-1'}', local_dir=${JSON.stringify(ALFRED_MODEL)})`]);
  if (fs.existsSync(path.join(ALFRED_MODEL, 'pyproject.toml')) || fs.existsSync(path.join(ALFRED_MODEL, 'setup.py'))) {
    sh(venvPy(), ['-m', 'pip', 'install', '--quiet', '-e', ALFRED_MODEL]);
  } else if (fs.existsSync(path.join(ALFRED_MODEL, 'requirements.txt'))) {
    sh(venvPy(), ['-m', 'pip', 'install', '--quiet', '-r', path.join(ALFRED_MODEL, 'requirements.txt')]);
  }
  fs.copyFileSync(path.join(ROOT, 'alfred', 'batcave_alfred.py'), path.join(ALFRED_DIR, 'batcave_alfred.py'));
  out('\n✓ Alfred installed. Start it next to your Batcave server with: batcave alfred start');
}

function alfredArgs() {
  return [path.join(ALFRED_DIR, 'batcave_alfred.py'), '--model', ALFRED_MODEL, '--port', String(flags['alfred-port'] || flags.port || 4778), '--device', String(flags.device || 'cpu')];
}

function alfredStart(detach) {
  if (!fs.existsSync(venvPy()) || !fs.existsSync(ALFRED_MODEL)) die('Alfred not installed. Run: batcave alfred install');
  fs.copyFileSync(path.join(ROOT, 'alfred', 'batcave_alfred.py'), path.join(ALFRED_DIR, 'batcave_alfred.py'));
  if (!detach) return spawnSync(venvPy(), alfredArgs(), { stdio: 'inherit' });
  const log = fs.openSync(path.join(ALFRED_DIR, 'alfred.log'), 'a');
  const child = spawn(venvPy(), alfredArgs(), { detached: true, stdio: ['ignore', log, log] });
  fs.writeFileSync(path.join(ALFRED_DIR, 'alfred.pid'), String(child.pid));
  child.unref();
  out(`✓ Alfred starting in the background (pid ${child.pid}). Log: ${path.join(ALFRED_DIR, 'alfred.log')}`);
  return child;
}

async function alfredStatus() {
  const url = (process.env.BATCAVE_ALFRED_URL || `http://127.0.0.1:${flags.port || 4778}`).replace(/\/+$/, '');
  try {
    const h = await fetch(url + '/health', { signal: AbortSignal.timeout(2000) }).then((r) => r.json());
    const s = await fetch(url + '/stats', { signal: AbortSignal.timeout(2000) }).then((r) => r.json()).catch(() => ({}));
    out(`${h.loaded ? '✓' : '…'} Alfred at ${url}: ${h.loaded ? 'ready' : h.error ? 'error' : 'loading'} · model ${h.model} on ${h.device}${h.load_ms ? ` · loaded in ${h.load_ms} ms` : ''}`);
    if (h.error) out(`  ${h.error}`);
    if (s.calls) out(`  ${s.calls} decisions · p50 ${s.p50_ms} ms · p95 ${s.p95_ms} ms`);
  } catch { out(`○ No alfred running at ${url}. Start it with: batcave alfred start`); }
}

async function printStats() {
  const { loadConfig, api } = await import(pathToFileURL(path.join(PLUGIN, 'lib', 'client.mjs')).href);
  let s;
  try { s = await api(loadConfig(), 'GET', '/api/stats', undefined, 5000); } catch (e) { die(e.message); }
  const t = s.tokens, n = (x) => Number(x || 0).toLocaleString('en-US');
  out(`Batcave stats since ${new Date(s.since).toISOString().slice(0, 16).replace('T', ' ')} UTC\n`);
  out('Tokens');
  out(`  injected into agents      ${n(t.injected)}`);
  out(`  saved by dedupe           ${n(t.savedDedupe)}`);
  out(`  saved by ranking (Alfred)  ${n(t.savedRanking)}`);
  out(`  saved overall             ${n(t.saved)}  (${t.savedPct}%)`);
  out(`\nAlfred  ${s.alfred.ready ? `ready · ${s.alfred.model} on ${s.alfred.device}` : s.alfred.enabled ? 'not running (plain rules in use)' : 'off'}`);
  const rows = Object.entries(s.latency).filter(([k]) => /^(hook|alfred|api:GET \/api\/(context|guard)|agent)/.test(k)).sort();
  if (rows.length) {
    out('\nLatency (ms)                         count     p50     p95');
    for (const [k, v] of rows) out(`  ${k.padEnd(34)} ${String(v.count).padStart(6)} ${String(v.p50 ?? '-').padStart(7)} ${String(v.p95 ?? '-').padStart(7)}`);
  }
  const q = Object.entries(s.alfred.quality || {}).sort();
  if (q.length) {
    out('\nJudgments                    decisions  outcomes   taken');
    for (const [k, v] of q) out(`  ${k.padEnd(28)} ${String(v.decisions).padStart(7)} ${String(v.withOutcome).padStart(9)} ${(v.rate == null ? '-' : v.rate + '%').padStart(7)}`);
  }
  const c = s.counters;
  out(`\nActivity  claims ${c.claims || 0} · guard checks ${c.guard_checks || 0} (${c.guard_conflicts || 0} conflicts) · requests ${c.requests || 0} · handoffs ${c.handoffs || 0} · decisions ${c.decisions || 0}`);
}

const HELP = `batcave: multiplayer coding agents

Setup
  batcave init [--agent auto|all|claude,codex,gemini,cursor,copilot,opencode]
               [--url URL --token TOKEN --user HANDLE --name NAME] [--repo]
      Connect this machine to your team and wire Batcave into your agents.
      --agent defaults to every agent found on this machine.
      --repo also adds a Batcave section to ./AGENTS.md.
  batcave uninstall [--agent ...]    Remove Batcave from agents (backups are kept)
  batcave agents                     Show supported agents and which are installed here
  batcave doctor                     Check config and server
  batcave server [--port 4777] [--alfred]
                                     Run a Batcave server (needs BATCAVE_TEAM_TOKEN);
                                     --alfred also starts the local decision model
  batcave stats                      Team latency and token savings

Alfred (optional local decision model, Julia-1)
  batcave alfred install              Download Julia-1 from Hugging Face into ~/.batcave/alfred
  batcave alfred start [--detach] [--device cpu|mps|cuda]
  batcave alfred status

Team (works from any shell, no agent needed)
  batcave board [--mine]             batcave people
  batcave task <title>               batcave claim <id> [--force]
  batcave release <id>               batcave status <id> <backlog|claimed|running|review|done>
  batcave room [room]                batcave say <message>
  batcave decide <decision> [--pattern RE]   batcave decisions
  batcave check <plan or code>       checks it against pinned decisions
  batcave ask <handle|team> <request>    batcave requests [--sent]
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
        out(`✓ ${inst.label}`);
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
    out('Agent                      Found here');
    for (const [, inst] of Object.entries(INSTALLERS)) {
      let found = false; try { found = inst.detect(); } catch {}
      out(`${inst.label.padEnd(27)}${found ? 'yes' : '-'}`);
    }
    break;
  }

  case 'doctor': {
    const r = spawnSync(process.execPath, [path.join(PLUGIN, 'scripts', 'doctor.mjs')], { stdio: 'inherit' });
    process.exit(r.status || 0);
  }

  case 'alfred': {
    const sub = rest[0];
    if (sub === 'install') alfredInstall();
    else if (sub === 'start') alfredStart(Boolean(flags.detach));
    else if (sub === 'status') await alfredStatus();
    else die('Usage: batcave alfred <install|start|status>');
    break;
  }

  case 'stats': await printStats(); break;

  case 'server': {
    if (flags.alfred) alfredStart(true);
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
  case 'decide': if (!rest.length) die('Usage: batcave decide <decision>'); await run('batcave_decide', { text: rest.join(' '), pattern: typeof flags.pattern === 'string' ? flags.pattern : undefined }); break;
  case 'check': if (!rest.length) die('Usage: batcave check <plan or code>'); await run('batcave_decision_check', { text: rest.join(' ') }); break;
  case 'decisions': await run('batcave_decisions', {}); break;
  case 'ask': if (rest.length < 2) die('Usage: batcave ask <handle|team> <request>'); await run('batcave_request', { to: rest[0] === 'team' ? 'auto' : rest[0], text: rest.slice(1).join(' ') }); break;
  case 'requests': await run('batcave_requests', { box: flags.sent ? 'sent' : 'inbox' }); break;
  case 'accept': if (!rest[0]) die('Usage: batcave accept <id>'); await run('batcave_request_resolve', { id: rest[0], action: 'accept' }); break;
  case 'decline': if (!rest[0]) die('Usage: batcave decline <id>'); await run('batcave_request_resolve', { id: rest[0], action: 'decline' }); break;
  case 'handoff': if (rest.length < 3) die('Usage: batcave handoff <id> <handle> <summary>'); await run('batcave_handoff', { task: rest[0], to: rest[1], summary: rest.slice(2).join(' ') }); break;
  case 'pickup': if (!rest[0]) die('Usage: batcave pickup <id>'); await run('batcave_pickup', { id: rest[0] }); break;
  case 'pulse': await run('batcave_pulse', { hours: Number(rest[0]) || 24 }); break;

  default: die(`Unknown command "${cmd}". Run batcave help.`);
}
