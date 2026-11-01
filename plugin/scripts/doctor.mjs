#!/usr/bin/env node
// Check that everything Batcave needs is in place. Prints one line per check.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, api, CONFIG_FILE } from '../lib/client.mjs';

let failed = 0;
const ok = (m) => console.log(`✓ ${m}`);
const bad = (m, fix) => { failed++; console.log(`✗ ${m}${fix ? `\n    fix: ${fix}` : ''}`); };
const warn = (m) => console.log(`! ${m}`);

const major = Number(process.versions.node.split('.')[0]);
major >= 18 ? ok(`Node ${process.versions.node}`) : bad(`Node ${process.versions.node} is too old`, 'install Node 18 or newer');

const cfg = loadConfig();
fs.existsSync(CONFIG_FILE) ? ok(`Config file ${CONFIG_FILE}`) : bad('No ~/.batcave/config.json', 'run /batcave:setup');
cfg.url ? ok(`Server URL ${cfg.url}`) : bad('No server URL', 'node scripts/setup.mjs --url <url>');
cfg.user ? ok(`Handle ${cfg.user}`) : bad('No handle', 'node scripts/setup.mjs --user <handle>');
cfg.root ? ok(`Git repo ${cfg.root}`) : warn('Not inside a git repo: the guard will use absolute paths');

if (cfg.url) {
  try {
    const h = await fetch(cfg.url + '/api/health').then((r) => r.json());
    ok(`Server up: team "${h.team}" v${h.version}`);
    if (h.auth && !cfg.token) bad('Server needs a team token and none is configured', 'node scripts/setup.mjs --token <token>');
  } catch (e) { bad(`Cannot reach ${cfg.url}: ${e.message}`, 'check the URL, VPN, or that the server is running'); }
}

if (cfg.ready) {
  try {
    const ctx = await api(cfg, 'GET', '/api/context', undefined, 5000);
    ok(`Authenticated. Active task: ${ctx.task ? ctx.task.id : 'none'}`);
  } catch (e) { bad(`API call failed: ${e.message}`, 'check the team token'); }
}

const settingsFile = path.join(os.homedir(), '.claude', 'settings.json');
try {
  const s = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  String(s.statusLine?.command || '').includes('statusline.mjs') ? ok('Status line installed') : warn('Status line not installed (optional): setup.mjs --statusline');
} catch { warn('No ~/.claude/settings.json yet (status line optional)'); }

console.log(failed ? `\n${failed} problem(s) found.` : '\nAll good.');
process.exit(failed ? 1 : 0);
