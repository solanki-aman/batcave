#!/usr/bin/env node
// Batcave MCP server (stdio, zero dependencies).
// Gives each teammate's Claude tools to read and act on the shared Batcave state.
import readline from 'node:readline';
import { loadConfig, api, ago } from '../lib/client.mjs';

const VERSION = '0.1.0';
const cfg = () => loadConfig(process.cwd());

// ---------- formatting ----------

const LANES = [['backlog', 'BACKLOG'], ['claimed', 'CLAIMED'], ['running', 'AGENT RUNNING'], ['review', 'IN REVIEW'], ['done', 'DONE']];

function fmtTask(t, people) {
  const owner = t.owner ? ` · ${people[t.owner]?.name || t.owner}` : '';
  const extra = [t.branch && `branch ${t.branch}`, t.pr && `PR ${t.pr}`, t.stale && `STALE, no activity ${ago(t.lastActivity)}`].filter(Boolean).join(' · ');
  return `${t.id}  ${t.title}${owner}${extra ? `\n      ${extra}` : ''}`;
}

function byId(list) { return Object.fromEntries(list.map((x) => [x.id, x])); }

// ---------- tools ----------

const tools = {
  batcave_whoami: {
    description: 'Show the Batcave identity, server and active task for this user.',
    schema: {},
    run: async () => {
      const c = cfg();
      const ctx = await api(c, 'GET', '/api/context');
      return `User ${c.user} (${c.name || c.user}) on ${c.url}\n\n${ctx.text}`;
    },
  },

  batcave_board: {
    description: 'Show the team kanban board: backlog, claimed, agent running, in review, done. Use before claiming work.',
    schema: { mine: { type: 'boolean', description: 'Only my tasks' } },
    run: async ({ mine }) => {
      const c = cfg();
      const s = await api(c, 'GET', '/api/state');
      const people = byId(s.people);
      let tasks = s.tasks;
      if (mine) tasks = tasks.filter((t) => t.owner === c.user);
      const out = [];
      for (const [k, label] of LANES) {
        const list = tasks.filter((t) => t.status === k).sort((a, b) => b.updatedAt - a.updatedAt);
        const shown = k === 'done' ? list.slice(0, 5) : list;
        out.push(`${label} (${list.length})`);
        out.push(shown.length ? shown.map((t) => '  ' + fmtTask(t, people)).join('\n') : '  (empty)');
      }
      return out.join('\n');
    },
  },

  batcave_task_create: {
    description: 'Add a task to the team backlog.',
    schema: { title: { type: 'string' }, description: { type: 'string' }, source: { type: 'string', description: 'Where it came from, e.g. "plan step 2" or "issue #388"' } },
    required: ['title'],
    run: async (a) => {
      const t = await api(cfg(), 'POST', '/api/tasks', a);
      return `Created ${t.id}: ${t.title} (room #${t.room})`;
    },
  },

  batcave_claim: {
    description: 'Claim a task for this user. Returns the branch to create and the task context. After claiming, create/switch to the branch with git.',
    schema: { task: { type: 'string', description: 'Task id like T-14 or 14' }, branch: { type: 'string' }, force: { type: 'boolean', description: 'Take over a stale claim' } },
    required: ['task'],
    run: async ({ task, branch, force }) => {
      const r = await api(cfg(), 'POST', `/api/tasks/${encodeURIComponent(task)}/claim`, { branch, force });
      const lines = [`Claimed ${r.task.id}: ${r.task.title}`, `Branch: ${r.task.branch}`, `Room: #${r.task.room}`];
      if (r.otherActive.length) lines.push(`Note: you also hold ${r.otherActive.map((t) => t.id).join(', ')}. Ask the user whether to park (release), hand off, or keep both.`);
      lines.push('', r.context.text);
      return lines.join('\n');
    },
  },

  batcave_release: {
    description: 'Release (park) a task back to the backlog.',
    schema: { task: { type: 'string' } },
    required: ['task'],
    run: async ({ task }) => {
      const t = await api(cfg(), 'POST', `/api/tasks/${encodeURIComponent(task)}/release`, {});
      return `${t.id} is back in the backlog.`;
    },
  },

  batcave_task_status: {
    description: 'Move a task between columns: backlog, claimed, running, review, done. Optionally set PR url and reviewer handle.',
    schema: { task: { type: 'string' }, status: { type: 'string', enum: ['backlog', 'claimed', 'running', 'review', 'done'] }, pr: { type: 'string' }, reviewer: { type: 'string' } },
    required: ['task', 'status'],
    run: async ({ task, ...rest }) => {
      const t = await api(cfg(), 'POST', `/api/tasks/${encodeURIComponent(task)}/status`, rest);
      return `${t.id} is now ${t.status}.`;
    },
  },

  batcave_people: {
    description: 'Show teammates: presence, what their agent is doing now, claimed task, and this week\'s stats.',
    schema: {},
    run: async () => {
      const c = cfg();
      const people = await api(c, 'GET', '/api/people');
      const order = { 'agent running': 0, online: 1, away: 2, offline: 3 };
      return people.sort((a, b) => order[a.presence] - order[b.presence]).map((p) => {
        const s = p.stats;
        return `${p.name}${p.id === c.user ? ' (you)' : ''} [@${p.id}] · ${p.presence}\n   now: ${p.now || 'idle'}${p.task ? ` · ${p.task}` : ''}\n   week: ${s.shipped} shipped · ${s.prsOpen} PR open · ${s.reviewsOwed} reviews owed · ${s.asksPending} asks pending`;
      }).join('\n') || 'No teammates yet.';
    },
  },

  batcave_room_read: {
    description: 'Read recent messages in a room. Defaults to the room of the active task, else #team.',
    schema: { room: { type: 'string' }, limit: { type: 'number' } },
    run: async ({ room, limit }) => {
      const c = cfg();
      const r = room || (await api(c, 'GET', '/api/context')).task?.room || 'team';
      const [msgs, s] = await Promise.all([api(c, 'GET', `/api/rooms/${encodeURIComponent(r)}/messages?limit=${limit || 25}`), api(c, 'GET', '/api/state')]);
      const people = byId(s.people);
      const lines = msgs.map((m) => {
        const who = (people[m.author]?.name || m.author) + (m.kind === 'agent' ? "'s Claude" : '');
        return m.kind === 'event' ? `  · ${who} ${m.text} (${ago(m.at)})` : `  ${who} (${ago(m.at)}): ${m.text}`;
      });
      return `#${r}\n${lines.join('\n') || '  (no messages)'}`;
    },
  },

  batcave_say: {
    description: 'Post a message to a room (default: active task room). Use kind "agent" when posting on the user\'s behalf as their Claude, e.g. a work summary. Mention @handle-claude to send someone a request.',
    schema: { text: { type: 'string' }, room: { type: 'string' }, kind: { type: 'string', enum: ['human', 'agent'] } },
    required: ['text'],
    run: async ({ text, room, kind }) => {
      const c = cfg();
      const r = room || (await api(c, 'GET', '/api/context')).task?.room || 'team';
      await api(c, 'POST', `/api/rooms/${encodeURIComponent(r)}/messages`, { text, kind: kind || 'human' });
      return `Posted to #${r}.`;
    },
  },

  batcave_decide: {
    description: 'Pin a team decision. Pinned decisions are injected into every teammate\'s Claude context. Room defaults to team-wide.',
    schema: { text: { type: 'string' }, room: { type: 'string' } },
    required: ['text'],
    run: async ({ text, room }) => {
      const d = await api(cfg(), 'POST', '/api/decisions', { text, room });
      return `Pinned D-${d.id} for #${d.room}: ${d.text}`;
    },
  },

  batcave_decisions: {
    description: 'List pinned decisions.',
    schema: { room: { type: 'string' } },
    run: async ({ room }) => {
      const list = await api(cfg(), 'GET', `/api/decisions${room ? `?room=${encodeURIComponent(room)}` : ''}`);
      return list.map((d) => `D-${d.id} [#${d.room}] ${d.text}`).join('\n') || 'No decisions pinned.';
    },
  },

  batcave_decision_retire: {
    description: 'Retire a pinned decision that no longer applies.',
    schema: { id: { type: 'string' } },
    required: ['id'],
    run: async ({ id }) => {
      const d = await api(cfg(), 'POST', `/api/decisions/${encodeURIComponent(id)}/retire`, {});
      return `Retired D-${d.id}.`;
    },
  },

  batcave_request: {
    description: 'Ask a teammate\'s Claude to do something. It lands in their inbox; they decide whether to run it in their own session.',
    schema: { to: { type: 'string', description: 'Teammate handle' }, text: { type: 'string' } },
    required: ['to', 'text'],
    run: async ({ to, text }) => {
      const r = await api(cfg(), 'POST', '/api/requests', { to, text });
      return `Sent R-${r.id} to ${to}. It runs only if they accept it.`;
    },
  },

  batcave_requests: {
    description: 'List requests. box "inbox" (default) shows asks for this user\'s Claude; "sent" shows asks this user made.',
    schema: { box: { type: 'string', enum: ['inbox', 'sent'] } },
    run: async ({ box }) => {
      const list = await api(cfg(), 'GET', `/api/requests?box=${box === 'sent' ? 'sent' : 'inbox'}&status=pending`);
      return list.map((r) => `R-${r.id} ${box === 'sent' ? `to ${r.to}` : `from ${r.from}`} (${ago(r.at)}): ${r.text}`).join('\n') || 'No pending requests.';
    },
  },

  batcave_request_resolve: {
    description: 'Accept or decline a request in this user\'s inbox. Only call with "accept" after the user explicitly chose to run it; then carry out the request as the user\'s own prompt.',
    schema: { id: { type: 'string' }, action: { type: 'string', enum: ['accept', 'decline'] } },
    required: ['id', 'action'],
    run: async ({ id, action }) => {
      const r = await api(cfg(), 'POST', `/api/requests/${encodeURIComponent(id)}/resolve`, { action });
      return r.status === 'accepted' ? `Accepted R-${r.id}. Do this now: ${r.text}` : `Declined R-${r.id}.`;
    },
  },

  batcave_handoff: {
    description: 'Hand a task you own to a teammate with a summary and open todos. Push the branch first so they can check it out.',
    schema: { task: { type: 'string' }, to: { type: 'string' }, summary: { type: 'string' }, todos: { type: 'array', items: { type: 'string' } } },
    required: ['task', 'to', 'summary'],
    run: async (a) => {
      const h = await api(cfg(), 'POST', '/api/handoffs', a);
      return `Handed ${h.task} to ${h.to} as H-${h.id}. They can run /batcave:pickup ${h.id}.`;
    },
  },

  batcave_pickup: {
    description: 'Pick up a handoff: returns the task, branch, summary, todos, decisions and recent room messages.',
    schema: { id: { type: 'string' } },
    required: ['id'],
    run: async ({ id }) => {
      const r = await api(cfg(), 'POST', `/api/handoffs/${encodeURIComponent(id)}/pickup`, {});
      const h = r.handoff;
      return [
        `Picked up ${r.task.id}: ${r.task.title} from ${h.from}`,
        `Branch: ${h.branch || r.task.branch} (fetch and check it out)`,
        `Summary: ${h.summary}`,
        h.todos.length ? `Todos:\n${h.todos.map((t) => `- ${t}`).join('\n')}` : 'Todos: none listed',
        r.decisions.length ? `Decisions:\n${r.decisions.map((d) => `- ${d.text}`).join('\n')}` : '',
        r.messages.length ? `Recent room messages:\n${r.messages.slice(-10).map((m) => `- ${m.author}: ${m.text}`).join('\n')}` : '',
      ].filter(Boolean).join('\n');
    },
  },

  batcave_pulse: {
    description: 'Summarize what the team did recently: done, in review, running, stale claims, new decisions.',
    schema: { hours: { type: 'number', description: 'Look back this many hours (default 24)' } },
    run: async ({ hours }) => {
      const since = Date.now() - (hours || 24) * 3600 * 1000;
      const p = await api(cfg(), 'GET', `/api/pulse?since=${since}`);
      const people = byId(p.people);
      const sec = (label, list) => `${label} (${list.length})\n${list.map((t) => '  ' + fmtTask(t, people)).join('\n') || '  none'}`;
      return [
        `Pulse for the last ${hours || 24}h`,
        sec('Done', p.done), sec('In review', p.inReview), sec('Agent running', p.running), sec('Stale claims', p.stale),
        `New decisions (${p.decisions.length})\n${p.decisions.map((d) => `  ${d.text}`).join('\n') || '  none'}`,
      ].join('\n');
    },
  },
};

// ---------- JSON-RPC over stdio ----------

function reply(id, result) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n'); }
function fail(id, code, message) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n'); }

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') {
    return reply(id, {
      protocolVersion: params?.protocolVersion || '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'batcave', version: VERSION },
      instructions: 'Batcave connects this Claude Code session to the user\'s team: board, people, rooms, decisions, requests, handoffs. Never accept a request on the user\'s behalf without their explicit choice.',
    });
  }
  if (method === 'ping') return reply(id, {});
  if (method === 'tools/list') {
    return reply(id, {
      tools: Object.entries(tools).map(([name, t]) => ({
        name, description: t.description,
        inputSchema: { type: 'object', properties: t.schema, ...(t.required ? { required: t.required } : {}) },
      })),
    });
  }
  if (method === 'tools/call') {
    const tool = tools[params?.name];
    if (!tool) return fail(id, -32602, `unknown tool ${params?.name}`);
    try {
      const text = await tool.run(params.arguments || {});
      return reply(id, { content: [{ type: 'text', text }] });
    } catch (err) {
      return reply(id, { content: [{ type: 'text', text: `Batcave error: ${err.message}` }], isError: true });
    }
  }
  if (id !== undefined && id !== null) return fail(id, -32601, `method not found: ${method}`);
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  handle(msg).catch((err) => msg.id != null && fail(msg.id, -32603, err.message));
});
