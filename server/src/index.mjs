// Batcave server: the shared state behind every teammate's coding agent.
// Zero dependencies. Node 18+.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { Store } from './store.mjs';
import { Stats, estTokens } from './stats.mjs';
import { Alfred, yesProb, topChoice } from './alfred.mjs';
import { Assist } from './assist.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VERSION = '0.4.0';

const PORT = Number(process.env.PORT || 4777);
const HOST = process.env.HOST || '0.0.0.0';
const TEAM = process.env.BATCAVE_TEAM || 'batcave';
const TOKEN = process.env.BATCAVE_TEAM_TOKEN || '';
const DATA_FILE = process.env.BATCAVE_DATA || path.join(process.cwd(), 'data', 'batcave.json');
const STALE_HOURS = Number(process.env.BATCAVE_STALE_HOURS || 24);
const GUARD_MINUTES = Number(process.env.BATCAVE_GUARD_MINUTES || 60);
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const store = new Store(DATA_FILE);
const db = store.data;
const stats = new Stats(store);
const alfred = new Alfred(stats);
const assist = new Assist({ alfred, stats, store, dataFile: DATA_FILE });

// ---------- helpers ----------

const now = () => Date.now();
const DAY = 24 * 60 * 60 * 1000;
const ACTIVE = new Set(['claimed', 'running']);
const STATUSES = ['backlog', 'claimed', 'running', 'review', 'done'];

function slugify(s, max = 32) {
  let out = String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (out.length > max) {
    out = out.slice(0, max);
    const cut = out.lastIndexOf('-');
    if (cut > max / 2) out = out.slice(0, cut);
  }
  return out.replace(/-+$/g, '') || 'task';
}

function cleanId(s) {
  return String(s || '').trim().toLowerCase().replace(/[^a-z0-9._-]/g, '');
}

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function need(cond, status, message) { if (!cond) throw new HttpError(status, message); }

function str(v, field, max = 4000) {
  need(typeof v === 'string' && v.trim(), 400, `${field} is required`);
  return v.trim().slice(0, max);
}

// ---------- realtime (SSE) ----------

const clients = new Set();

function broadcast(type, payload) {
  const line = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of clients) res.write(line);
  store.save();
}

setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 25000).unref();

// ---------- domain ----------

function person(id) { return db.people[id]; }

function touchPerson(id, name) {
  let p = db.people[id];
  if (!p) {
    p = db.people[id] = {
      id, name: name || id, role: '', status: 'online', lastSeen: now(),
      agent: 'idle', now: '', task: null, branch: null, since: now(),
    };
  }
  if (name && name !== p.name) p.name = name;
  p.lastSeen = now();
  if (p.status === 'offline' || p.status === 'away') p.status = 'online';
  return p;
}

function presenceOf(p) {
  if (p.status === 'offline') return 'offline';
  if (p.status === 'away') return 'away';
  const idle = now() - p.lastSeen;
  if (idle > 60 * 60 * 1000) return 'offline';
  if (idle > 10 * 60 * 1000) return 'away';
  return p.agent === 'running' ? 'agent running' : 'online';
}

function statsOf(id) {
  const weekAgo = now() - 7 * DAY;
  const tasks = Object.values(db.tasks);
  return {
    shipped: tasks.filter((t) => t.owner === id && t.status === 'done' && (t.doneAt || 0) > weekAgo).length,
    prsOpen: tasks.filter((t) => t.owner === id && t.status === 'review').length,
    reviewsOwed: tasks.filter((t) => t.reviewer === id && t.status === 'review').length,
    asksPending: db.requests.filter((r) => r.from === id && r.status === 'pending').length,
  };
}

function publicPerson(p) {
  return { ...p, presence: presenceOf(p), stats: statsOf(p.id) };
}

function idleTooLong(t) {
  return ACTIVE.has(t.status) && now() - (t.lastActivity || t.updatedAt) > STALE_HOURS * 60 * 60 * 1000;
}
// A claim goes stale when it sits idle, unless its owner said they paused it.
function decisionsFor(me) {
  const t = activeTaskOf(me);
  return db.decisions.filter((d) => d.active && (d.room === 'team' || (t && d.room === t.room)));
}

function isStale(t) { return idleTooLong(t) && !t.paused; }

function publicTask(t) { return { ...t, stale: isStale(t) }; }

function activeTaskOf(id) {
  return Object.values(db.tasks)
    .filter((t) => t.owner === id && ACTIVE.has(t.status))
    .sort((a, b) => (b.lastActivity || 0) - (a.lastActivity || 0))[0] || null;
}

function getTask(id) {
  const key = String(id || '').toUpperCase().replace(/^T?-?(\d+)$/, 'T-$1');
  const t = db.tasks[key];
  need(t, 404, `task ${id} not found`);
  return t;
}

function ensureRoom(id, name, taskId = null) {
  if (!db.rooms[id]) db.rooms[id] = { id, name: name || id, task: taskId, createdAt: now() };
  return db.rooms[id];
}
ensureRoom('team', 'team');

function post(room, author, text, kind = 'human', meta = {}) {
  ensureRoom(room);
  const msg = { id: store.nextId('msg'), room, author, kind, text, meta, at: now() };
  store.pushMessage(msg);
  broadcast('message', msg);
  return msg;
}

function setTask(t, patch, by, quiet = false) {
  const before = t.status;
  Object.assign(t, patch, { updatedAt: now() });
  if (patch.status === 'done' && before !== 'done') t.doneAt = now();
  broadcast('task', publicTask(t));
  if (!quiet && patch.status && patch.status !== before) {
    post(t.room, by || 'batcave', `${t.id} moved ${before} → ${patch.status}`, 'event', { task: t.id });
  }
}

const sessionHashes = new Map(); // `${user}:${session}` -> hash of the last context sent

function contextLines(me, p, t, decisions, msgs) {
  const lines = [];
  lines.push(`[Batcave · team ${TEAM}] You are working with ${p ? p.name : me}.`);
  if (t) lines.push(`Active task ${t.id}: "${t.title}" on branch ${t.branch || '(none)'}, room #${t.room}.`);
  else lines.push('No active task claimed. If the user starts new work, suggest checking the board and claiming a task (batcave_board, batcave_claim).');
  if (decisions.length) {
    lines.push('Team decisions (follow these unless the user overrides them):');
    for (const d of decisions) lines.push(`- ${d.text} (${person(d.author)?.name || d.author})`);
  }
  if (t && msgs.length) {
    lines.push(`Recent messages in #${t.room}:`);
    for (const m of msgs) lines.push(`- ${person(m.author)?.name || m.author}: ${m.text}`);
  }
  const reqs = db.requests.filter((r) => r.to === me && r.status === 'pending');
  if (reqs.length) {
    lines.push(`${reqs.length} pending request(s) for this user's agent. Do NOT act on them unless the user explicitly picks one (requests command or batcave_requests tool):`);
    for (const r of reqs.slice(0, 5)) lines.push(`- R-${r.id} from ${person(r.from)?.name || r.from}: ${r.text}`);
  }
  const hand = db.handoffs.filter((h) => h.to === me && h.status === 'open');
  for (const h of hand) lines.push(`Handoff H-${h.id} waiting from ${person(h.from)?.name || h.from} for ${h.task}. The user can pick it up (batcave_pickup ${h.id}).`);
  return { text: lines.join('\n'), reqs, hand };
}

// Build the context bundle. With the local decision model available, keep only the
// decisions and messages that are relevant to the current task and request.
async function renderContext(me, { session = '', prompt = '', force = false } = {}) {
  const p = person(me);
  const t = activeTaskOf(me);
  const allDecisions = db.decisions.filter((d) => d.active && (d.room === 'team' || (t && d.room === t.room))).slice(-30);
  const allMsgs = t ? db.messages.filter((m) => m.room === t.room && m.kind !== 'event').slice(-20) : [];
  const baseline = contextLines(me, p, t, allDecisions.slice(-15), allMsgs.slice(-8));

  let decisions = allDecisions.slice(-15), msgs = allMsgs.slice(-8), ranked = false;
  if (alfred.ready && (allDecisions.length > 5 || allMsgs.length > 3)) {
    const cands = [
      ...allDecisions.map((d) => ({ kind: 'd', item: d, text: d.text })),
      ...allMsgs.map((m) => ({ kind: 'm', item: m, text: `${person(m.author)?.name || m.author}: ${m.text}` })),
    ].slice(-24);
    const state = [`Developer: ${p?.name || me}`, t ? `Task ${t.id}: ${t.title}` : 'No active task', prompt ? `Current request: ${String(prompt).slice(0, 600)}` : ''].filter(Boolean).join('\n');
    const questions = Object.fromEntries(cands.map((c, i) => [`c${i}`, { type: 'noul', instructions: `Is this team note relevant to the developer's current task or request? Note: ${c.text.slice(0, 300)}` }]));
    const answers = await alfred.decide(state, questions, 'rank');
    if (answers) {
      const scored = cands.map((c, i) => ({ ...c, p: yesProb(answers[`c${i}`]) ?? 1 }));
      const ds = scored.filter((c) => c.kind === 'd');
      decisions = (ds.length <= 5 ? ds : ds.filter((c) => c.p >= 0.35).sort((a, b) => b.p - a.p).slice(0, 8)).map((c) => c.item);
      if (!decisions.length && ds.length) decisions = ds.sort((a, b) => b.p - a.p).slice(0, 3).map((c) => c.item);
      msgs = scored.filter((c) => c.kind === 'm' && c.p >= 0.5).sort((a, b) => b.p - a.p).slice(0, 6).map((c) => c.item).sort((a, b) => a.at - b.at);
      ranked = true;
    }
  }

  let { text, reqs, hand } = contextLines(me, p, t, decisions, msgs);
  const suggestion = !t && prompt ? await suggestTask(me, prompt) : null;
  if (suggestion) text += `\nThe user's request looks like backlog task ${suggestion.task.id}: "${suggestion.task.title}". Before starting, ask the user whether to claim it (batcave_claim ${suggestion.task.id}).`;
  if (ranked) stats.tokens('savedRanking', Math.max(0, estTokens(baseline.text) - estTokens(text)));

  let changed = true;
  if (session) {
    const key = `${me}:${session}`;
    const hash = crypto.createHash('sha1').update(text).digest('hex');
    changed = force || sessionHashes.get(key) !== hash;
    sessionHashes.set(key, hash);
    if (sessionHashes.size > 5000) sessionHashes.delete(sessionHashes.keys().next().value);
  }
  if (changed) stats.tokens('injected', estTokens(text)); else stats.tokens('savedDedupe', estTokens(text));
  stats.count('context_served');
  return { task: t ? publicTask(t) : null, suggestion: suggestion ? { task: suggestion.task.id, title: suggestion.task.title } : null, decisions, requests: reqs, handoffs: hand, text, changed, ranked, tokens: estTokens(text), baselineTokens: estTokens(baseline.text) };
}

// Alfred use 1: the user started work with no claim; does it match a backlog card?
async function suggestTask(me, prompt) {
  const p = person(me);
  const backlog = Object.values(db.tasks).filter((x) => x.status === 'backlog' || (x.status === 'claimed' && !x.owner));
  const hit = await assist.matchTask(String(prompt), backlog);
  if (p.suggestion && p.suggestion.task !== hit?.task.id) assist.outcome(p.suggestion.decisionId, 'ignored');
  p.suggestion = hit ? { task: hit.task.id, title: hit.task.title, decisionId: hit.decisionId, at: now() } : null;
  broadcast('person', publicPerson(p));
  return hit;
}

// Short profile of a teammate, used to route requests.
function profileOf(x) {
  const t = activeTaskOf(x.id);
  const files = [...new Set(db.touches.filter((y) => y.person === x.id).slice(-30).map((y) => path.basename(y.file)))].slice(-8);
  const done = Object.values(db.tasks).filter((y) => y.owner === x.id && y.status !== 'backlog').slice(-4).map((y) => y.title);
  return [x.name || x.id, x.role && `role ${x.role}`, t && `working on ${t.title}`, done.length && `owns ${done.join('; ')}`, files.length && `recently edited ${files.join(', ')}`].filter(Boolean).join('. ');
}

async function routeRequest(me, text) {
  const people = Object.values(db.people).filter((x) => x.id !== me).map((x) => ({ id: x.id, profile: profileOf(x) }));
  return assist.route(text, people);
}

// Classify a human room message; suggest pinning it when it reads like a team decision.
async function classifyMessage(msg) {
  if (!alfred.ready || msg.kind !== 'human' || msg.text.length < 12) return;
  const answers = await alfred.decide(msg.text, {
    kind: {
      type: 'choice',
      instructions: 'What kind of team chat message is this?',
      criteria: {
        decision: 'A decision or rule the team agreed to follow',
        question: 'A question for someone',
        blocker: 'Something is blocked or broken',
        update: 'A status update on work',
        chatter: 'Social or other chatter',
      },
    },
  }, 'classify');
  const top = topChoice(answers?.kind);
  if (!top) return;
  msg.meta = { ...(msg.meta || {}), kind: top.choice, confidence: top.p };
  stats.count(`messages_${top.choice}`);
  if (top.choice === 'decision' && (Number.isNaN(top.p) || top.p >= 0.6)) {
    msg.meta.suggestPin = true;
    msg.meta.decisionId = assist.log('pin', { text: msg.text.slice(0, 200) }, 'decision', 'alfred', top.p);
  }
  broadcast('message', msg);
}

// Alfred use 6: before a quiet claim turns stale, check whether its owner said they paused it.
async function sweepPaused() {
  for (const t of Object.values(db.tasks)) {
    if (!t.owner || t.paused || !idleTooLong(t) || t.pausedCheckedAt > (t.lastActivity || 0)) continue;
    t.pausedCheckedAt = now();
    const since = (t.lastActivity || t.updatedAt) - 3 * DAY;
    const said = db.messages.filter((m) => m.author === t.owner && m.kind === 'human' && m.at > since && (m.room === t.room || m.room === 'team'));
    const r = await assist.pausedOrAbandoned(t, said);
    if (r.paused) { t.paused = { at: now(), decisionId: r.decisionId }; broadcast('task', publicTask(t)); }
  }
}
setInterval(() => sweepPaused().catch(() => {}), 10 * 60 * 1000).unref();
setTimeout(() => sweepPaused().catch(() => {}), 5000).unref();

// ---------- routes ----------

const routes = [];
const route = (method, pattern, handler, opts = {}) => {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, pattern, re, keys, handler, opts });
};

route('GET', '/api/health', () => ({ ok: true, team: TEAM, version: VERSION, auth: Boolean(TOKEN) }), { public: true });

route('GET', '/api/state', () => ({
  team: TEAM,
  people: Object.values(db.people).map(publicPerson),
  tasks: Object.values(db.tasks).map(publicTask),
  rooms: Object.values(db.rooms),
  decisions: db.decisions.filter((d) => d.active),
  requests: db.requests.filter((r) => r.status === 'pending'),
  handoffs: db.handoffs.filter((h) => h.status === 'open'),
  savings: { tokens: stats.summary().tokens.saved, alfred: alfred.ready },
}));

// presence
route('POST', '/api/presence', ({ me, body }) => {
  const p = person(me);
  if (body.status) p.status = ['online', 'away', 'offline'].includes(body.status) ? body.status : p.status;
  if (body.agent) {
    if (body.agent !== p.agent) p.since = now();
    p.agent = body.agent === 'running' ? 'running' : 'idle';
  }
  if (typeof body.now === 'string') p.now = body.now.slice(0, 200);
  if (typeof body.role === 'string') p.role = body.role.slice(0, 60);
  if (typeof body.branch === 'string') p.branch = body.branch.slice(0, 120);
  if (typeof body.tool === 'string') p.tool = body.tool.slice(0, 40);
  const t = activeTaskOf(me);
  p.task = t ? t.id : null;
  broadcast('person', publicPerson(p));
  return publicPerson(p);
});

route('GET', '/api/people', () => Object.values(db.people).map(publicPerson));

// tasks / board
route('GET', '/api/tasks', ({ query }) => {
  let list = Object.values(db.tasks);
  if (query.status) list = list.filter((t) => t.status === query.status);
  if (query.owner) list = list.filter((t) => t.owner === query.owner);
  return list.map(publicTask);
});

route('POST', '/api/tasks', async ({ me, body }) => {
  const title = str(body.title, 'title', 200);
  const open = Object.values(db.tasks).filter((x) => x.status !== 'done');
  const dup = body.allowDuplicate ? null : await assist.duplicateOf(title, body.description, open);
  const n = store.nextId('task');
  const id = `T-${n}`;
  const room = `t${n}-${slugify(title, 24)}`;
  const t = {
    id, title, description: typeof body.description === 'string' ? body.description.slice(0, 4000) : '',
    source: typeof body.source === 'string' ? body.source.slice(0, 80) : 'task', status: 'backlog',
    owner: null, reviewer: null, branch: null, pr: null, room, files: [],
    createdBy: me, createdAt: now(), updatedAt: now(), lastActivity: now(),
  };
  if (dup) t.duplicateOf = { task: dup.task.id, decisionId: dup.decisionId };
  db.tasks[id] = t;
  ensureRoom(room, room, id);
  broadcast('task', publicTask(t));
  post(room, me, `created ${id}: ${title}${dup ? ` (looks like a duplicate of ${dup.task.id})` : ''}`, 'event', { task: id });
  return { ...publicTask(t), possibleDuplicate: dup ? { ...publicTask(dup.task), decisionId: dup.decisionId } : null };
});

route('GET', '/api/tasks/:id', ({ params }) => publicTask(getTask(params.id)));

route('POST', '/api/tasks/:id/claim', async ({ me, params, body }) => {
  const t = getTask(params.id);
  if (t.owner && t.owner !== me && !isStale(t) && !body.force) {
    throw new HttpError(409, `${t.id} is claimed by ${person(t.owner)?.name || t.owner}. Ask them for a handoff, or wait until it goes stale.`);
  }
  const others = Object.values(db.tasks).filter((x) => x.owner === me && ACTIVE.has(x.status) && x.id !== t.id);
  const branch = typeof body.branch === 'string' && body.branch.trim() ? body.branch.trim() : `${me}/${t.id.toLowerCase()}-${slugify(t.title, 24)}`;
  const prev = t.owner;
  const me0 = person(me);
  if (me0.suggestion) { assist.outcome(me0.suggestion.decisionId, me0.suggestion.task === t.id ? 'accepted' : 'rejected'); me0.suggestion = null; }
  if (t.paused) { assist.outcome(t.paused.decisionId, prev === me ? 'returned' : 'taken-over'); t.paused = null; }
  setTask(t, { owner: me, status: t.status === 'backlog' || t.status === 'claimed' ? 'claimed' : t.status, branch, lastActivity: now() }, me, true);
  post(t.room, me, prev && prev !== me ? `took over ${t.id} from ${person(prev)?.name || prev}` : `claimed ${t.id}`, 'event', { task: t.id });
  const p = person(me); p.task = t.id; p.branch = branch;
  broadcast('person', publicPerson(p));
  stats.count('claims');
  return { task: publicTask(t), otherActive: others.map(publicTask), context: await renderContext(me) };
});

route('POST', '/api/tasks/:id/release', ({ me, params }) => {
  const t = getTask(params.id);
  need(t.owner === me, 403, `only the owner can release ${t.id}`);
  setTask(t, { owner: null, status: 'backlog' }, me);
  return publicTask(t);
});

route('POST', '/api/tasks/:id/status', ({ me, params, body }) => {
  const t = getTask(params.id);
  need(STATUSES.includes(body.status), 400, `status must be one of ${STATUSES.join(', ')}`);
  const patch = { status: body.status, lastActivity: now() };
  if (typeof body.pr === 'string') patch.pr = body.pr.slice(0, 300);
  if (typeof body.reviewer === 'string') patch.reviewer = cleanId(body.reviewer);
  setTask(t, patch, me);
  return publicTask(t);
});

// rooms
route('GET', '/api/rooms', () => Object.values(db.rooms));

route('GET', '/api/rooms/:id/messages', ({ params, query }) => {
  const limit = Math.min(Number(query.limit) || 30, 200);
  return db.messages.filter((m) => m.room === params.id).slice(-limit);
});

route('POST', '/api/rooms/:id/messages', async ({ me, params, body }) => {
  const text = str(body.text, 'text');
  const kind = body.kind === 'agent' ? 'agent' : 'human';
  const msg = post(params.id, me, text, kind);
  // @mentions of a person's agent (@aman-agent, @aman-claude, @aman-codex...) become requests in their inbox
  for (const m of text.matchAll(/@([a-z0-9._-]+?)-(?:agent|claude|codex|cursor|gemini|copilot|opencode)\b/gi)) {
    const to = cleanId(m[1]);
    if (db.people[to] && to !== me) createRequest(me, to, text, params.id);
  }
  // @team-agent: let Alfred (or the rules) pick the teammate best placed to take it
  if (/@team-agent\b/i.test(text)) {
    const hit = await routeRequest(me, text);
    if (hit) {
      const r = createRequest(me, hit.person.id, text, params.id, hit.decisionId);
      post(r.room, 'batcave', `routed to ${person(hit.person.id)?.name || hit.person.id}'s agent`, 'event', { request: r.id });
    }
  }
  stats.count('messages');
  classifyMessage(msg).catch(() => {});
  return msg;
});

// decisions
route('GET', '/api/decisions', ({ query }) => db.decisions.filter((d) => d.active && (!query.room || d.room === query.room || d.room === 'team')));

route('POST', '/api/decisions', ({ me, body }) => {
  const d = { id: store.nextId('dec'), text: str(body.text, 'text', 500), room: cleanId(body.room) || 'team', author: me, at: now(), active: true };
  if (typeof body.pattern === 'string' && body.pattern.trim()) {
    const pattern = body.pattern.trim().slice(0, 200);
    try { new RegExp(pattern, 'i'); } catch { throw new HttpError(400, 'pattern is not a valid regular expression'); }
    d.pattern = pattern;
  }
  const src = body.fromMessage != null && db.messages.find((m) => String(m.id) === String(body.fromMessage));
  if (src?.meta?.decisionId) { assist.outcome(src.meta.decisionId, 'accepted'); src.meta.pinned = true; }
  db.decisions.push(d);
  stats.count('decisions');
  broadcast('decision', d);
  post(d.room, me, `decided: ${d.text}`, 'event', { decision: d.id });
  return d;
});

route('POST', '/api/decisions/:id/retire', ({ me, params }) => {
  const d = db.decisions.find((x) => String(x.id) === String(params.id).replace(/^D-?/i, ''));
  need(d, 404, 'decision not found');
  d.active = false;
  broadcast('decision', d);
  post(d.room, me, `retired decision: ${d.text}`, 'event', { decision: d.id });
  return d;
});

// requests (asks for someone else's agent; they choose to run them)
function createRequest(from, to, text, room, routedBy = null) {
  const r = { id: store.nextId('req'), from, to, text, room: room || activeTaskOf(to)?.room || 'team', status: 'pending', at: now() };
  if (routedBy) r.routed = { decisionId: routedBy };
  db.requests.push(r);
  stats.count('requests');
  broadcast('request', r);
  return r;
}

route('GET', '/api/requests', ({ me, query }) => {
  const box = query.box === 'sent' ? 'from' : 'to';
  return db.requests.filter((r) => r[box] === me && (!query.status || r.status === query.status));
});

route('POST', '/api/requests', async ({ me, body }) => {
  const text = str(body.text, 'text');
  let to = cleanId(body.to), routed = null;
  if (!to || to === 'auto' || to === 'team') {
    routed = await routeRequest(me, text);
    need(routed, 404, 'could not work out who should take this; name a teammate');
    to = routed.person.id;
  }
  need(db.people[to], 404, `no teammate called ${body.to}`);
  need(to !== me, 400, 'that is you');
  const r = createRequest(me, to, text, cleanId(body.room), routed?.decisionId);
  post(r.room, me, `asked ${person(to).name}'s agent: ${r.text}`, 'event', { request: r.id });
  return r;
});

route('POST', '/api/requests/:id/resolve', ({ me, params, body }) => {
  const r = db.requests.find((x) => String(x.id) === String(params.id).replace(/^R-?/i, ''));
  need(r, 404, 'request not found');
  need(r.to === me, 403, 'only the recipient can resolve a request');
  need(['accept', 'decline'].includes(body.action), 400, 'action must be accept or decline');
  r.status = body.action === 'accept' ? 'accepted' : 'declined';
  r.resolvedAt = now();
  if (r.routed) assist.outcome(r.routed.decisionId, r.status);
  broadcast('request', r);
  post(r.room, me, `${r.status} request from ${person(r.from)?.name || r.from}`, 'event', { request: r.id });
  return r;
});

// handoffs
route('POST', '/api/handoffs/check', async ({ body }) => assist.handoffGaps(str(body.summary, 'summary', 6000), Array.isArray(body.todos) ? body.todos.map(String) : []));

route('POST', '/api/handoffs', async ({ me, body }) => {
  const t = getTask(body.task);
  const to = cleanId(body.to);
  need(db.people[to], 404, `no teammate called ${body.to}`);
  need(t.owner === me, 403, `you do not own ${t.id}`);
  const h = {
    id: store.nextId('hand'), task: t.id, from: me, to, status: 'open', at: now(),
    summary: str(body.summary, 'summary', 6000),
    todos: Array.isArray(body.todos) ? body.todos.map(String).slice(0, 30) : [],
    branch: t.branch,
  };
  const gaps = await assist.handoffGaps(h.summary, h.todos);
  h.missing = gaps.missing;
  db.handoffs.push(h);
  stats.count('handoffs');
  setTask(t, { owner: to, status: 'claimed', lastActivity: now() }, me, true);
  post(t.room, me, `handed ${t.id} to ${person(to).name}`, 'event', { handoff: h.id });
  broadcast('handoff', h);
  return h;
});

route('GET', '/api/handoffs', ({ me }) => db.handoffs.filter((h) => (h.to === me || h.from === me) && h.status === 'open'));

route('POST', '/api/handoffs/:id/pickup', ({ me, params }) => {
  const h = db.handoffs.find((x) => String(x.id) === String(params.id).replace(/^H-?/i, ''));
  need(h, 404, 'handoff not found');
  need(h.to === me, 403, 'this handoff is not for you');
  h.status = 'picked'; h.pickedAt = now();
  const t = getTask(h.task);
  broadcast('handoff', h);
  return {
    handoff: h, task: publicTask(t),
    decisions: db.decisions.filter((d) => d.active && (d.room === 'team' || d.room === t.room)),
    messages: db.messages.filter((m) => m.room === t.room).slice(-20),
  };
});

// events from hooks: edits, commands, commits, PRs, turn boundaries
route('POST', '/api/events', async ({ me, body }) => {
  const p = person(me);
  const t = activeTaskOf(me);
  const type = String(body.type || '');
  if (t) t.lastActivity = now();
  if (t?.paused && type !== 'turn_end') { assist.outcome(t.paused.decisionId, 'returned'); t.paused = null; }

  if (type === 'turn_start') {
    p.agent = 'running'; p.since = now();
    if (typeof body.now === 'string') p.now = body.now.slice(0, 200);
    if (t && t.status === 'claimed') setTask(t, { status: 'running' }, me);
  } else if (type === 'turn_end') {
    p.agent = 'idle'; p.since = now();
    p.now = t ? `idle on ${t.id}` : 'idle';
  } else if (type === 'edit') {
    const files = Array.isArray(body.files) ? body.files.map(String).slice(0, 50) : [];
    const hint = typeof body.hint === 'string' ? body.hint.slice(0, 300) : '';
    for (const f of files) db.touches.push({ person: me, task: t?.id || null, file: f, at: now(), ...(hint ? { hint } : {}) });
    store.pruneTouches();
    if (t) t.files = [...new Set([...(t.files || []), ...files])].slice(-200);
    p.agent = 'running';
    p.now = files.length ? `editing ${path.basename(files[0])}` : p.now;
    if (t && t.status === 'claimed') setTask(t, { status: 'running' }, me);
  } else if (type === 'command') {
    p.now = `running ${String(body.command || '').slice(0, 60)}`;
  } else if (type === 'commit') {
    // Alfred use 5: link the commit to the right card (branch first, then the subject)
    const summary = String(body.summary || '').slice(0, 300);
    const mine = Object.values(db.tasks).filter((x) => x.owner === me && (ACTIVE.has(x.status) || x.status === 'review'));
    const link = await assist.linkCommit(summary, typeof body.branch === 'string' ? body.branch : '', mine);
    const target = link?.task || t;
    if (target) {
      target.lastActivity = now();
      target.commits = [...(target.commits || []), { summary, at: now() }].slice(-20);
      post(target.room, me, `committed ${summary}`, 'agent', { task: target.id, linkedBy: link?.source || 'active' });
      broadcast('task', publicTask(target));
    }
  } else if (type === 'pr') {
    if (t) setTask(t, { status: 'review', pr: String(body.url || body.summary || '').slice(0, 300) }, me);
  }
  broadcast('person', publicPerson(p));
  if (t) broadcast('task', publicTask(t));
  return { ok: true };
});

// guard: has someone else touched this file recently?
route('GET', '/api/guard', async ({ me, query }) => {
  const files = String(query.files || '').split(',').map((s) => s.trim()).filter(Boolean);
  const windowMs = (Number(query.minutes) || GUARD_MINUTES) * 60 * 1000;
  const hits = db.touches
    .filter((x) => x.person !== me && files.includes(x.file) && now() - x.at < windowMs)
    .reduce((acc, x) => {
      const key = `${x.person}:${x.file}`;
      if (!acc[key] || acc[key].at < x.at) acc[key] = { ...x, name: person(x.person)?.name || x.person };
      return acc;
    }, {});
  const list = Object.values(hits);
  stats.count('guard_checks');
  const change = String(query.change || '');
  // Decision check: does the change break a decision pinned for the team or this task?
  const breaks = change ? await assist.decisionConflicts(files[0], change, decisionsFor(me)) : [];
  if (breaks.length) stats.count('decision_breaks');
  if (!list.length) return { conflict: false, touches: [], breaks };
  stats.count('guard_conflicts');
  // Alfred use 3: is this a real overlap, or a trivial one (imports, unrelated hunks)?
  const sev = await assist.guardSeverity(list[0].file, change, list);
  if (sev.level === 'low') stats.count('guard_low');
  return { conflict: true, severity: sev.level, decisionId: sev.decisionId, source: sev.source, touches: list, breaks };
});

// Check a planned change or a plan against pinned decisions before doing it.
route('POST', '/api/decisions/check', async ({ me, body }) => ({
  breaks: await assist.decisionConflicts(String(body.file || ''), str(body.text, 'text', 4000), decisionsFor(me)),
}));

// context bundle injected into every prompt
route('GET', '/api/context', ({ me, query }) => renderContext(me, { session: query.session, prompt: query.prompt, force: query.force === '1' }));

// Alfred use 8: which of these events deserve a toast for me right now?
route('POST', '/api/notify-filter', async ({ me, body }) => {
  const items = Array.isArray(body.items) ? body.items.slice(0, 20).map((x) => ({ kind: String(x.kind || ''), text: String(x.text || '').slice(0, 300), room: String(x.room || '') })) : [];
  return { keep: await assist.worthToast(person(me)?.name || me, activeTaskOf(me), items) };
});

// Outcome of an Alfred suggestion, reported by clients (guard proceed/cancel, dismissals...).
route('POST', '/api/feedback', ({ body }) => ({ ok: assist.outcome(body.id, String(body.outcome || '')) }));

route('POST', '/api/sweep', async () => { await sweepPaused(); return { ok: true }; });

route('GET', '/api/alfred/log', ({ query }) => db.alfredLog.slice(-Math.min(Number(query.limit) || 50, 500)));

// stats: latency and savings for the team
route('GET', '/api/stats', () => ({
  ...stats.summary(),
  alfred: { enabled: !alfred.disabled, ready: alfred.ready, url: alfred.url, ...alfred.health, quality: assist.quality() },
  team: { people: Object.keys(db.people).length, tasks: Object.keys(db.tasks).length, decisions: db.decisions.filter((d) => d.active).length },
}));

// pulse: what changed since a timestamp
route('GET', '/api/pulse', ({ query }) => {
  const since = Number(query.since) || now() - DAY;
  const tasks = Object.values(db.tasks);
  return {
    since,
    done: tasks.filter((t) => (t.doneAt || 0) > since).map(publicTask),
    inReview: tasks.filter((t) => t.status === 'review').map(publicTask),
    running: tasks.filter((t) => t.status === 'running').map(publicTask),
    stale: tasks.filter(isStale).map(publicTask),
    decisions: db.decisions.filter((d) => d.at > since && d.active),
    people: Object.values(db.people).map(publicPerson),
  };
});

// ---------- http plumbing ----------

function send(res, status, body, headers = {}) {
  const data = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'content-type': typeof body === 'string' ? 'text/plain' : 'application/json', ...headers });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > 1e6) { reject(new HttpError(413, 'body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new HttpError(400, 'invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function authorized(req, url) {
  if (!TOKEN) return true;
  const h = req.headers.authorization || '';
  return h === `Bearer ${TOKEN}` || url.searchParams.get('token') === TOKEN;
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

function serveStatic(res, pathname) {
  const file = path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname);
  if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return send(res, 404, 'not found');
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (!url.pathname.startsWith('/api/')) return serveStatic(res, url.pathname);

    const match = routes.find((r) => r.method === req.method && r.re.test(url.pathname));

    if (url.pathname === '/api/stream' && req.method === 'GET') {
      if (!authorized(req, url)) return send(res, 401, { error: 'bad token' });
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write(`event: hello\ndata: ${JSON.stringify({ team: TEAM })}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }

    if (!match) return send(res, 404, { error: 'no such route' });
    if (!match.opts.public && !authorized(req, url)) return send(res, 401, { error: 'bad or missing team token' });

    const params = {};
    const m = url.pathname.match(match.re);
    match.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });

    let me = null;
    if (!match.opts.public) {
      me = cleanId(req.headers['x-batcave-user'] || url.searchParams.get('user'));
      if (!me) return send(res, 400, { error: 'missing X-Batcave-User header' });
      const name = req.headers['x-batcave-name'] ? decodeURIComponent(String(req.headers['x-batcave-name'])) : undefined;
      touchPerson(me, name);
    }

    const body = req.method === 'GET' ? {} : await readBody(req);
    const query = Object.fromEntries(url.searchParams);
    const t0 = performance.now();
    const result = await match.handler({ me, params, body, query, req });
    stats.time(`api:${match.method} ${match.pattern}`, performance.now() - t0);
    // clients report how long their previous hook took, end to end
    const hook = String(req.headers['x-batcave-hook'] || '').match(/^([a-z]+):([a-z-]+):(\d+(?:\.\d+)?)$/);
    if (hook) { stats.time(`hook:${hook[2]}`, Number(hook[3])); stats.time(`agent:${hook[1]}`, Number(hook[3])); }
    store.save();
    send(res, 200, result);
  } catch (err) {
    const status = err.status || 500;
    if (status === 500) console.error(err);
    send(res, status, { error: err.message });
  }
});

function shutdown() { store.flush(); process.exit(0); }
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.listen(PORT, HOST, () => {
  console.log(`[batcave] team "${TEAM}" listening on http://${HOST}:${PORT}${TOKEN ? ' (token required)' : ' (NO TOKEN: local use only)'}`);
  console.log(`[batcave] data: ${DATA_FILE}`);
});
