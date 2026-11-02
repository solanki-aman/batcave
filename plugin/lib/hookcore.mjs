// Agent-independent hook logic. Adapters (agents.mjs) translate each agent's
// payload into a normalized event, call handle(), then format the result.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { loadConfig, api, relPath, ago, HOME_DIR } from './client.mjs';

// Normalized event: { kind, agent, cwd, sessionId, tool: 'edit'|'shell'|'other', files: [], command, output }
// Result: { context?: string, guard?: { reason, mode: 'ask'|'deny' }, silent?: true }

function sessionFile(sessionId, suffix) {
  const dir = path.join(HOME_DIR, 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${String(sessionId || 'default').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80)}${suffix}.json`);
}

// Only re-send context when it changed since the last time in this session.
export function changedSinceLast(sessionId, text) {
  const hash = crypto.createHash('sha1').update(text).digest('hex');
  let last = null;
  try {
    const file = sessionFile(sessionId, '');
    try { last = JSON.parse(fs.readFileSync(file, 'utf8')).hash; } catch {}
    fs.writeFileSync(file, JSON.stringify({ hash, at: Date.now() }));
  } catch {}
  return hash !== last;
}

function git(args, cwd) {
  try { return execFileSync('git', args, { cwd: cwd || process.cwd(), stdio: ['ignore', 'pipe', 'ignore'], timeout: 1500 }).toString().trim(); } catch { return null; }
}
// Is this commit already in the local checkout? Unknown commits (not fetched yet) count as no.
const hasCommit = (sha, cwd) => git(['merge-base', '--is-ancestor', sha, 'HEAD'], cwd) !== null;

// For agents that cannot "ask": deny the first attempt per file per session, allow the retry.
function firstWarning(sessionId, file) {
  try {
    const f = sessionFile(sessionId, '-guard');
    let seen = [];
    try { seen = JSON.parse(fs.readFileSync(f, 'utf8')); } catch {}
    if (seen.includes(file)) return false;
    seen.push(file);
    fs.writeFileSync(f, JSON.stringify(seen.slice(-200)));
    return true;
  } catch { return true; }
}

// Remember how long each hook took and report it with the next request (no extra round trip).
const LAST = () => path.join(HOME_DIR, 'last-hook.json');
function takeLastTiming() {
  try { const v = JSON.parse(fs.readFileSync(LAST(), 'utf8')); fs.unlinkSync(LAST()); return v; } catch { return null; }
}
export function saveTiming(agent, mode, ms) {
  try { fs.mkdirSync(HOME_DIR, { recursive: true }); fs.writeFileSync(LAST(), JSON.stringify({ agent, mode, ms: Math.round(ms * 10) / 10 })); } catch {}
}

const ctxQuery = (ev, force) => `/api/context?session=${encodeURIComponent(`${ev.agent}:${ev.sessionId}`)}${ev.prompt ? `&prompt=${encodeURIComponent(String(ev.prompt).slice(0, 600))}` : ''}${force ? '&force=1' : ''}`;

// The Claude Code mod refreshes this marker every 15 s while it runs.
function modActive() {
  try { return Date.now() / 1000 - Number(fs.readFileSync(path.join(HOME_DIR, 'mod-active'), 'utf8')) < 60; } catch { return false; }
}

export async function handle(ev, { canAsk = true } = {}) {
  const cfg = loadConfig(ev.cwd || process.cwd());
  if (!cfg.ready) return { silent: true };
  const last = takeLastTiming();
  if (last) cfg.hookReport = `${last.agent}:${last.mode}:${last.ms}`;

  switch (ev.kind) {
    case 'session-start': {
      await api(cfg, 'POST', '/api/presence', { status: 'online', agent: 'idle', tool: ev.agent });
      const ctx = await api(cfg, 'GET', ctxQuery(ev, true));
      return { context: ctx.text };
    }

    case 'prompt': {
      await api(cfg, 'POST', '/api/events', { type: 'turn_start', now: 'thinking' });
      const ctx = await api(cfg, 'GET', ctxQuery(ev));
      const changed = ctx.changed ?? changedSinceLast(ev.sessionId, ctx.text);
      return changed ? { context: ctx.text } : {};
    }

    case 'refresh': {
      // mid-session context refresh (used where prompts cannot carry context)
      const ctx = await api(cfg, 'GET', ctxQuery(ev));
      const changed = ctx.changed ?? changedSinceLast(ev.sessionId, ctx.text);
      return changed ? { context: ctx.text } : {};
    }

    case 'pre-tool': {
      if (ev.tool !== 'edit' || !ev.files.length) return {};
      if (ev.agent === 'claude' && modActive()) return {}; // the Batcave mod holds the edit in a pane instead
      const files = ev.files.map((f) => relPath(f, cfg.root));
      const change = ev.hint ? `&change=${encodeURIComponent(ev.hint)}` : '';
      const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], ev.cwd) || '';
      const g = await api(cfg, 'GET', `/api/guard?files=${encodeURIComponent(files.join(','))}&minutes=${cfg.guardMinutes}${change}&branch=${encodeURIComponent(branch)}`);
      const breaks = g.breaks || [];
      const slices = g.slices || [];
      const behind = (g.upstream || []).filter((p) => !hasCommit(p.sha, ev.cwd));
      const realOverlap = g.conflict && g.severity !== 'low';
      if (!realOverlap && !breaks.length && !slices.length && !behind.length) {
        if (!g.conflict) return {};
        // Alfred judged the overlap trivial: let the edit through and just mention it
        const who = g.touches.map((t) => `${t.name}'s agent edited ${t.file} ${ago(t.at)}`).join('; ');
        return { context: `Batcave: ${who}. The overlap looks trivial, so the edit went ahead. Mention it to the user if it matters.` };
      }
      const parts = [];
      if (realOverlap) parts.push(g.touches.map((t) => `${t.name}'s agent edited ${t.file} ${ago(t.at)}${t.task ? ` (${t.task})` : ''}`).join('; '));
      if (breaks.length) parts.push(`this change looks like it breaks a team decision: ${breaks.map((b) => `"${b.text}" (D-${b.id}, ${b.author})`).join('; ')}`);
      if (behind.length) parts.push(`${behind.map((p) => `${p.name} pushed a newer ${p.files.filter((f) => files.includes(f)).join(', ')} to ${branch} (${p.sha.slice(0, 7)})`).join('; ')}. This checkout does not have it yet: pull first (git pull --rebase)`);
      if (slices.length) parts.push(slices.map((x) => `${x.file} is in ${x.name}'s slice of #${x.roomName} (${x.slice})`).join('; ') + '. Ask them in the room before changing it');
      const what = parts.join('. Also, ');
      if (canAsk) {
        return { guard: { mode: 'ask', reason: `Batcave guard: ${what}. ${breaks.length ? 'Change the edit to follow the decision, or ' : 'Coordinate before editing, or '}approve to continue.` } };
      }
      const key = files.join(',') + (breaks.length ? `#d${breaks.map((b) => b.id).join('.')}` : '') + (behind.length ? `#p${behind[0].sha.slice(0, 7)}` : '');
      if (!firstWarning(ev.sessionId, key)) return {};
      return { guard: { mode: 'deny', reason: `Batcave guard: ${what}. ${breaks.length ? 'Rework the edit so it follows the decision, or stop and tell the user. ' : 'Stop and tell the user before editing. '}If they say go ahead, retry the same edit and Batcave will allow it.` } };
    }

    case 'post-tool': {
      if (!cfg.shareActivity) return {};
      if (ev.tool === 'edit' && ev.files.length) {
        await api(cfg, 'POST', '/api/events', { type: 'edit', files: ev.files.map((f) => relPath(f, cfg.root)), hint: ev.hint || '' });
        return {};
      }
      if (ev.tool === 'shell' && ev.command) {
        const cmd = ev.command;
        const isCommit = /\bgit\s+commit\b/.test(cmd), isPush = /\bgit\s+push\b/.test(cmd);
        if (isCommit || isPush) {
          const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], ev.cwd) || '';
          const summary = isCommit ? git(['log', '-1', '--format=%h %s'], ev.cwd) : '';
          if (summary) await api(cfg, 'POST', '/api/events', { type: 'commit', summary, branch });
          if (isPush && !/rejected|error:|fatal:/i.test(String(ev.output || ''))) {
            const sha = git(['rev-parse', 'HEAD'], ev.cwd);
            if (sha) await api(cfg, 'POST', '/api/events', { type: 'push', branch, sha });
          }
          return {};
        }
        if (/\bgh\s+pr\s+create\b/.test(cmd)) {
          const url = (String(ev.output || '').match(/https:\/\/github\.com\/[^\s"'\\]+\/pull\/\d+/) || [])[0];
          if (url) await api(cfg, 'POST', '/api/events', { type: 'pr', url });
          return {};
        }
        await api(cfg, 'POST', '/api/events', { type: 'command', command: cmd.split('\n')[0].slice(0, 80) });
      }
      return {};
    }

    case 'stop':
      await api(cfg, 'POST', '/api/events', { type: 'turn_end' });
      return {};

    case 'session-end':
      await api(cfg, 'POST', '/api/presence', { status: 'offline', agent: 'idle' });
      return {};
  }
  return {};
}
