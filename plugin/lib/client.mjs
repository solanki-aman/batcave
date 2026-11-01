// Shared client for hooks, the MCP server and scripts.
// Config precedence: env vars > ~/.batcave/config.json > <repo>/.batcave.json (no secrets in repo files).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const HOME_DIR = process.env.BATCAVE_HOME || path.join(os.homedir(), '.batcave');
export const CONFIG_FILE = path.join(HOME_DIR, 'config.json');

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}

export function gitRoot(cwd = process.cwd()) {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, stdio: ['ignore', 'pipe', 'ignore'], timeout: 1500 }).toString().trim();
  } catch { return null; }
}

export function loadConfig(cwd = process.cwd()) {
  const root = gitRoot(cwd);
  const repo = root ? readJson(path.join(root, '.batcave.json')) : {};
  const home = readJson(CONFIG_FILE);
  const cfg = {
    url: process.env.BATCAVE_URL || home.url || repo.url || '',
    token: process.env.BATCAVE_TOKEN || home.token || '',
    user: (process.env.BATCAVE_USER || home.user || '').toLowerCase(),
    name: process.env.BATCAVE_NAME || home.name || '',
    guardMinutes: Number(repo.guardMinutes || home.guardMinutes || 60),
    shareActivity: (repo.shareActivity ?? home.shareActivity) !== false,
    root,
  };
  cfg.url = cfg.url.replace(/\/+$/, '');
  cfg.ready = Boolean(cfg.url && cfg.user);
  return cfg;
}

export function saveHomeConfig(patch) {
  fs.mkdirSync(HOME_DIR, { recursive: true, mode: 0o700 });
  const next = { ...readJson(CONFIG_FILE), ...patch };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
  return next;
}

export async function api(cfg, method, route, body, timeoutMs = 2500) {
  if (!cfg.ready) throw new Error('Batcave is not set up. Run /batcave:setup.');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(cfg.url + route, {
      method,
      signal: ctrl.signal,
      headers: {
        'content-type': 'application/json',
        'x-batcave-user': cfg.user,
        'x-batcave-name': encodeURIComponent(cfg.name || cfg.user),
        ...(cfg.token ? { authorization: `Bearer ${cfg.token}` } : {}),
        ...(cfg.hookReport ? { 'x-batcave-hook': cfg.hookReport } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    cfg.hookReport = undefined;
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || `${res.status} ${res.statusText}`);
    return json;
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`Batcave server at ${cfg.url} did not answer in ${timeoutMs}ms`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export function relPath(file, root) {
  if (!file) return null;
  const abs = path.resolve(file);
  if (root && abs.startsWith(root + path.sep)) return abs.slice(root.length + 1).split(path.sep).join('/');
  return abs.split(path.sep).join('/');
}

export function ago(t) {
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  if (m < 1440) return `${Math.round(m / 60)}h ago`;
  return `${Math.round(m / 1440)}d ago`;
}
