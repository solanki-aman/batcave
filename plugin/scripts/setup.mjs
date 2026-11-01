#!/usr/bin/env node
// Configure this machine for Batcave.
//   node setup.mjs --url https://batcave.example.com --token <team token> --user aman --name "Aman" [--statusline]
// Writes ~/.batcave/config.json (mode 600), checks the server, and optionally
// adds the Batcave status line to ~/.claude/settings.json (with a backup).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { saveHomeConfig, loadConfig, api, CONFIG_FILE } from '../lib/client.mjs';

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (!a.startsWith('--')) continue;
  const key = a.slice(2);
  const next = process.argv[i + 1];
  if (next === undefined || next.startsWith('--')) args[key] = true; else { args[key] = next; i++; }
}

function fail(msg) { console.error(`✗ ${msg}`); process.exit(1); }

const patch = {};
if (args.url) patch.url = String(args.url).replace(/\/+$/, '');
if (args.token) patch.token = String(args.token);
if (args.user) patch.user = String(args.user).trim().toLowerCase().replace(/[^a-z0-9._-]/g, '');
if (args.name) patch.name = String(args.name);
if (Object.keys(patch).length) saveHomeConfig(patch);

const cfg = loadConfig();
if (!cfg.url) fail('No server URL. Pass --url.');
if (!cfg.user) fail('No handle. Pass --user (lowercase, e.g. aman).');
console.log(`✓ Config saved to ${CONFIG_FILE}`);

const health = await fetch(cfg.url + '/api/health').then((r) => r.json()).catch((e) => fail(`Cannot reach ${cfg.url}: ${e.message}`));
console.log(`✓ Server reachable: team "${health.team}", v${health.version}${health.auth ? ', token required' : ', no token'}`);
if (health.auth && !cfg.token) fail('Server requires a team token. Pass --token.');

try {
  await api(cfg, 'POST', '/api/presence', { status: 'online' }, 5000);
  console.log(`✓ Signed in as ${cfg.user}${cfg.name ? ` (${cfg.name})` : ''}`);
} catch (e) { fail(`Server rejected the request: ${e.message}`); }

if (args.statusline) {
  const settingsFile = path.join(os.homedir(), '.claude', 'settings.json');
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'statusline.mjs');
  let settings = {};
  if (fs.existsSync(settingsFile)) {
    settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    fs.copyFileSync(settingsFile, `${settingsFile}.bak-batcave`);
  }
  if (settings.statusLine && !String(settings.statusLine.command || '').includes('statusline.mjs') && !args.force) {
    console.log(`! You already have a status line (${settings.statusLine.command}). Re-run with --statusline --force to replace it.`);
  } else {
    settings.statusLine = { type: 'command', command: `node "${script}"` };
    fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
    fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + '\n');
    console.log(`✓ Status line set in ${settingsFile} (backup: settings.json.bak-batcave)`);
  }
}

console.log('\nDone. Restart your coding agent, then try the board and people commands.');
