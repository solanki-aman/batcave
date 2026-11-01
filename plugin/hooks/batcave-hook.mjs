#!/usr/bin/env node
// One entry point for every Batcave hook. Always fails open: a slow or missing
// server must never block someone's Claude Code session.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { loadConfig, api, relPath, ago, HOME_DIR } from '../lib/client.mjs';

const mode = process.argv[2];

function readStdin() {
  try { return JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch { return {}; }
}

function emit(event, extra) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: event, ...extra } }));
}

// Inject context only when it changed since the last prompt in this session.
function changedSinceLast(sessionId, text) {
  const dir = path.join(HOME_DIR, 'sessions');
  const file = path.join(dir, `${String(sessionId || 'default').replace(/[^a-zA-Z0-9_-]/g, '')}.json`);
  const hash = crypto.createHash('sha1').update(text).digest('hex');
  let last = null;
  try { last = JSON.parse(fs.readFileSync(file, 'utf8')).hash; } catch {}
  try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(file, JSON.stringify({ hash, at: Date.now() })); } catch {}
  return hash !== last;
}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

async function main() {
  const input = readStdin();
  const cfg = loadConfig(input.cwd || process.cwd());
  if (!cfg.ready) return;

  switch (mode) {
    case 'session-start': {
      await api(cfg, 'POST', '/api/presence', { status: 'online', agent: 'idle' });
      const ctx = await api(cfg, 'GET', '/api/context');
      changedSinceLast(input.session_id, ctx.text);
      emit('SessionStart', { additionalContext: ctx.text });
      return;
    }

    case 'prompt': {
      await api(cfg, 'POST', '/api/events', { type: 'turn_start', now: 'thinking' });
      const ctx = await api(cfg, 'GET', '/api/context');
      if (changedSinceLast(input.session_id, ctx.text)) emit('UserPromptSubmit', { additionalContext: ctx.text });
      return;
    }

    case 'pre-tool': {
      if (!EDIT_TOOLS.has(input.tool_name)) return;
      const file = relPath(input.tool_input?.file_path || input.tool_input?.notebook_path, cfg.root);
      if (!file) return;
      const g = await api(cfg, 'GET', `/api/guard?files=${encodeURIComponent(file)}&minutes=${cfg.guardMinutes}`);
      if (!g.conflict) return;
      const who = g.touches.map((t) => `${t.name}'s Claude edited it ${ago(t.at)}${t.task ? ` (${t.task})` : ''}`).join('; ');
      emit('PreToolUse', {
        permissionDecision: 'ask',
        permissionDecisionReason: `Batcave guard: ${file} is in flight elsewhere. ${who}. Coordinate before editing, or approve to continue.`,
      });
      return;
    }

    case 'post-tool': {
      if (!cfg.shareActivity) return;
      if (EDIT_TOOLS.has(input.tool_name)) {
        const file = relPath(input.tool_input?.file_path || input.tool_input?.notebook_path, cfg.root);
        if (file) await api(cfg, 'POST', '/api/events', { type: 'edit', files: [file] });
        return;
      }
      if (input.tool_name === 'Bash') {
        const cmd = String(input.tool_input?.command || '');
        const out = JSON.stringify(input.tool_response || '');
        if (/\bgit\s+commit\b/.test(cmd)) {
          let summary = '';
          try { summary = execFileSync('git', ['log', '-1', '--format=%h %s'], { cwd: input.cwd || process.cwd(), stdio: ['ignore', 'pipe', 'ignore'], timeout: 1500 }).toString().trim(); } catch {}
          if (summary) await api(cfg, 'POST', '/api/events', { type: 'commit', summary });
          return;
        }
        if (/\bgh\s+pr\s+create\b/.test(cmd)) {
          const url = (out.match(/https:\/\/github\.com\/[^\s"\\]+\/pull\/\d+/) || [])[0];
          if (url) await api(cfg, 'POST', '/api/events', { type: 'pr', url });
          return;
        }
        await api(cfg, 'POST', '/api/events', { type: 'command', command: cmd.split('\n')[0].slice(0, 80) });
      }
      return;
    }

    case 'stop':
      await api(cfg, 'POST', '/api/events', { type: 'turn_end' });
      return;

    case 'session-end':
      await api(cfg, 'POST', '/api/presence', { status: 'offline', agent: 'idle' });
      return;
  }
}

main().catch((err) => {
  if (process.env.BATCAVE_DEBUG) process.stderr.write(`[batcave] ${mode}: ${err.message}\n`);
}).finally(() => process.exit(0));
