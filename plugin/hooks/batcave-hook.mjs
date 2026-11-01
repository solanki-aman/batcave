#!/usr/bin/env node
// One entry point for every Batcave hook, for every supported agent.
//   node batcave-hook.mjs <session-start|prompt|refresh|pre-tool|post-tool|stop|session-end> [--agent claude|codex|gemini|antigravity|cursor|copilot]
// Always fails open: a slow or missing server never blocks anyone's session.
import fs from 'node:fs';
import { normalize, adapterFor } from '../lib/agents.mjs';
import { handle, saveTiming } from '../lib/hookcore.mjs';

const mode = process.argv[2];
const ai = process.argv.indexOf('--agent');
const agent = ai > 0 ? process.argv[ai + 1] : 'claude';
const adapter = adapterFor(agent);

function readStdin() {
  try { return JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch { return {}; }
}

const t0 = performance.now();

async function main() {
  const ev = normalize(agent, mode, readStdin());
  let result = await handle(ev, { canAsk: adapter.canAsk });
  if (adapter.refreshOnPostTool && mode === 'post-tool' && !result.context) {
    const r = await handle({ ...ev, kind: 'refresh' }, { canAsk: adapter.canAsk });
    if (r.context) result = { ...result, context: r.context };
  }
  const out = adapter.format(mode, result || {});
  if (out) process.stdout.write(JSON.stringify(out));
}

main().catch((err) => {
  if (process.env.BATCAVE_DEBUG) process.stderr.write(`[batcave] ${agent} ${mode}: ${err.message}\n`);
  // Cursor expects an answer on pre-tool; default to allow on error.
  if (agent === 'cursor' && mode === 'pre-tool') process.stdout.write(JSON.stringify({ permission: 'allow' }));
}).finally(() => { saveTiming(agent, mode, performance.now() - t0); process.exit(0); });
