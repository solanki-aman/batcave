#!/usr/bin/env node
// Claude Code status line: "● acme · 4 online · 1 request · T-11 running"
// Cached for 10s so it stays instant. Prints nothing if Batcave is not set up.
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, api, HOME_DIR } from '../lib/client.mjs';

const CACHE = path.join(HOME_DIR, 'statusline-cache.json');
const TTL = 10_000;

let input = {};
try { input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch {}
const cfg = loadConfig(input.workspace?.current_dir || input.cwd || process.cwd());

function render(s) {
  const online = s.people.filter((p) => p.presence !== 'offline' && p.presence !== 'away').length;
  const reqs = s.requests.filter((r) => r.to === cfg.user).length;
  const reviews = s.tasks.filter((t) => t.status === 'review' && t.reviewer === cfg.user).length;
  const mine = s.tasks.filter((t) => t.owner === cfg.user && (t.status === 'claimed' || t.status === 'running'))
    .sort((a, b) => b.lastActivity - a.lastActivity)[0];
  const parts = [`● ${s.team}`, `${online} online`];
  if (reqs) parts.push(`${reqs} request${reqs > 1 ? 's' : ''}`);
  if (reviews) parts.push(`${reviews} review${reviews > 1 ? 's' : ''} owed`);
  parts.push(mine ? `${mine.id} ${mine.status}` : 'no claim');
  return parts.join(' · ');
}

async function main() {
  if (!cfg.ready) return;
  try {
    const c = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
    if (Date.now() - c.at < TTL && c.user === cfg.user) return process.stdout.write(c.line);
  } catch {}
  try {
    const line = render(await api(cfg, 'GET', '/api/state', undefined, 1500));
    fs.mkdirSync(HOME_DIR, { recursive: true });
    fs.writeFileSync(CACHE, JSON.stringify({ at: Date.now(), user: cfg.user, line }));
    process.stdout.write(line);
  } catch {
    process.stdout.write('○ batcave offline');
  }
}
main();
