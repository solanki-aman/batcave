// Alfred's judgment calls. Each one asks the local decision model when it is
// running and falls back to plain rules when it is not, so Batcave behaves the
// same way (only less sharply) without Alfred. Every call is logged with its
// answer, and outcomes are attached later, so we can measure how often Alfred
// is right and, one day, fine-tune on real data.
import fs from 'node:fs';
import path from 'node:path';
import { yesProb, topChoice } from './alfred.mjs';

const STOP = new Set('the a an and or of to in on for with from by at as is are be this that it its into via use using add fix make new update our we you i my me'.split(' '));
export const words = (s) => new Set(String(s || '').toLowerCase().match(/[a-z0-9]{3,}/g)?.filter((w) => !STOP.has(w)) ?? []);
export function overlap(a, b) {
  const A = words(a), B = words(b);
  if (!A.size || !B.size) return 0;
  let n = 0;
  for (const w of A) if (B.has(w)) n += 1;
  return n / Math.min(A.size, B.size);
}

export const SPEAK_BAR = Number(process.env.BATCAVE_SPEAK_BAR || 0.75);
export const DECISION_BAR = Number(process.env.BATCAVE_DECISION_BAR || 0.7);

export class Assist {
  constructor({ alfred, stats, store, dataFile }) {
    this.alfred = alfred;
    this.stats = stats;
    this.db = store.data;
    this.db.alfredLog ||= [];
    this.db.seq.dlog ||= 0;
    this.store = store;
    this.file = dataFile ? path.join(path.dirname(dataFile), 'alfred-decisions.jsonl') : null;
  }

  // ---- log and outcomes ----------------------------------------------------

  log(kind, input, output, source, p = null) {
    const entry = { id: ++this.db.seq.dlog, at: Date.now(), kind, source, p: p == null || Number.isNaN(p) ? null : Math.round(p * 1000) / 1000, input, output, outcome: null };
    this.db.alfredLog.push(entry);
    if (this.db.alfredLog.length > 2000) this.db.alfredLog.splice(0, this.db.alfredLog.length - 2000);
    this.stats.count(`assist_${kind}`);
    this.append(entry);
    return entry.id;
  }

  outcome(id, outcome) {
    const e = this.db.alfredLog.find((x) => x.id === Number(id));
    if (!e || e.outcome) return false;
    e.outcome = String(outcome).slice(0, 40);
    e.outcomeAt = Date.now();
    this.append({ id: e.id, outcome: e.outcome, at: e.outcomeAt });
    return true;
  }

  append(row) {
    if (!this.file) return;
    try { fs.mkdirSync(path.dirname(this.file), { recursive: true }); fs.appendFileSync(this.file, JSON.stringify(row) + '\n'); } catch { /* logging must never break a request */ }
  }

  // How often each kind of suggestion was taken, by source.
  quality() {
    const GOOD = new Set(['accepted', 'correct', 'proceeded-low', 'cancelled-real', 'returned', 'fixed', 'helpful']);
    const out = {};
    for (const e of this.db.alfredLog) {
      const k = (out[`${e.kind}:${e.source}`] ||= { decisions: 0, withOutcome: 0, good: 0 });
      k.decisions += 1;
      if (e.outcome) { k.withOutcome += 1; if (GOOD.has(e.outcome)) k.good += 1; }
    }
    for (const v of Object.values(out)) v.rate = v.withOutcome ? Math.round((v.good / v.withOutcome) * 1000) / 10 : null;
    return out;
  }

  // Shortlist: with embeddings available, keep only the k candidates closest
  // in meaning to the query, so Julia-1 decides among a few. Otherwise fall back
  // to the first `cap` candidates, as before.
  async narrow(query, items, k, cap, textOf, label) {
    if (items.length <= k) return { items, embedded: false };
    const sl = this.embed ? await this.embed.shortlist(query, items, k, textOf, label) : null;
    return sl ? { items: sl.map((x) => x.item), embedded: true, sims: sl.map((x) => x.sim) } : { items: items.slice(0, cap), embedded: false };
  }

  async choose(state, instructions, options, label) {
    const criteria = Object.fromEntries(options.map((o) => [o.key, o.desc.slice(0, 200)]));
    const answers = await this.alfred.decide(state, { pick: { type: 'choice', instructions, criteria } }, label);
    return topChoice(answers?.pick);
  }

  async yesno(state, items, label) {
    const questions = Object.fromEntries(items.map((q, i) => [`q${i}`, { type: 'noul', instructions: q }]));
    const answers = await this.alfred.decide(state, questions, label);
    return answers ? items.map((_, i) => yesProb(answers[`q${i}`])) : null;
  }

  // ---- 1. match a prompt to a backlog card --------------------------------

  async matchTask(prompt, tasks) {
    if (!prompt || !tasks.length) return null;
    const n = await this.narrow(prompt, tasks, 6, 15, (t) => `${t.title}. ${t.description || ''}`, 'match');
    const cands = n.items;
    let pick = null, source = 'rules', p = null;
    const top = await this.choose(`Request: ${prompt.slice(0, 600)}`, 'Which backlog task is this request working on?',
      [...cands.map((t) => ({ key: t.id, desc: t.title + (t.description ? `. ${t.description}` : '') })), { key: 'none', desc: 'None of these; unrelated work' }], 'match');
    if (top) { source = 'alfred'; p = top.p; pick = top.choice !== 'none' && (Number.isNaN(top.p) || top.p >= 0.5) ? cands.find((t) => t.id === top.choice) : null; }
    else {
      const scored = cands.map((t) => ({ t, s: overlap(prompt, `${t.title} ${t.description || ''}`) })).sort((a, b) => b.s - a.s)[0];
      if (scored && scored.s >= 0.5) { pick = scored.t; p = scored.s; }
    }
    if (n.embedded) source = `embed+${source}`;
    const id = this.log('match', { prompt: prompt.slice(0, 300), candidates: cands.map((t) => t.id) }, pick?.id ?? 'none', source, p);
    return pick ? { task: pick, p, source, decisionId: id } : null;
  }

  // ---- 2. duplicate cards -------------------------------------------------

  async duplicateOf(title, description, tasks) {
    if (!tasks.length) return null;
    const n = await this.narrow(`${title}. ${description || ''}`, tasks, 5, 20, (t) => `${t.title}. ${t.description || ''}`, 'duplicate');
    const cands = n.items;
    let hit = null, source = 'rules', p = null;
    const ps = await this.yesno(`New task: ${title}. ${description || ''}`.slice(0, 800),
      cands.map((t) => `Is the new task the same piece of work as this existing task: ${t.title}?`), 'duplicate');
    if (ps) {
      source = 'alfred';
      const best = ps.map((x, i) => ({ x, t: cands[i] })).sort((a, b) => (b.x ?? 0) - (a.x ?? 0))[0];
      if (best && (best.x ?? 0) >= 0.6) { hit = best.t; p = best.x; }
    } else {
      const best = cands.map((t) => ({ t, s: overlap(title, t.title) })).sort((a, b) => b.s - a.s)[0];
      if (best && best.s >= 0.75) { hit = best.t; p = best.s; }
    }
    if (n.embedded) source = `embed+${source}`;
    const id = this.log('duplicate', { title: title.slice(0, 200), candidates: cands.map((t) => t.id) }, hit?.id ?? 'none', source, p);
    return hit ? { task: hit, p, source, decisionId: id } : null;
  }

  // ---- 3. guard severity ----------------------------------------------------

  async guardSeverity(file, change, touches) {
    const theirs = touches.map((t) => t.hint).filter(Boolean);
    let level = 'real', source = 'rules', p = null;
    if (change && theirs.length) {
      const ps = await this.yesno(`File: ${file}\nMy change: ${change.slice(0, 400)}`,
        theirs.slice(0, 4).map((h) => `Could my change conflict with or undo this teammate's change to the same file: ${h.slice(0, 300)}?`), 'guard');
      if (ps) { source = 'alfred'; p = Math.max(...ps.map((x) => x ?? 1)); level = p < 0.3 ? 'low' : 'real'; }
      else {
        const trivial = String(change).split('\n').every((l) => /^\s*(import\b|export \{|from\b|require\(|\/\/|#|$)/.test(l));
        const shared = Math.max(...theirs.map((h) => overlap(change, h)));
        level = trivial || shared < 0.1 ? 'low' : 'real';
        p = shared;
      }
    }
    const id = this.log('guard', { file, change: (change || '').slice(0, 200), theirs: theirs.map((h) => h.slice(0, 120)) }, level, source, p);
    return { level, p, source, decisionId: id };
  }

  // ---- 3b. decision check: does this change break a pinned decision? ------
  //
  // A decision can carry a regex `pattern` (set when it is pinned); a match is a
  // certain hit and works without Alfred. Alfred adds the judgment calls a
  // pattern cannot express. The bar is high on purpose: a false stop costs the
  // developer more than a miss, so only confident answers count.

  async decisionConflicts(file, change, decisions) {
    const text = String(change || '').trim();
    const cands = decisions.slice(-12);
    if (!text || !cands.length) return [];
    const hits = new Map();
    for (const d of cands) {
      if (!d.pattern) continue;
      try { if (new RegExp(d.pattern, 'i').test(text)) hits.set(d.id, { d, p: 1, source: 'pattern' }); } catch { /* bad pattern: ignore */ }
    }
    const rest = cands.filter((d) => !hits.has(d.id));
    const ps = rest.length ? await this.yesno(`File: ${file}\nChange:\n${text.slice(0, 900)}`,
      rest.map((d) => `Does this change go against the team decision "${d.text.slice(0, 240)}"?`), 'decision') : null;
    if (ps) rest.forEach((d, i) => { if ((ps[i] ?? 0) >= DECISION_BAR) hits.set(d.id, { d, p: ps[i], source: 'alfred' }); });
    return [...hits.values()].map(({ d, p, source }) => ({
      id: d.id, text: d.text, author: d.author, room: d.room, p: Math.round(p * 100) / 100, source,
      logId: this.log('decision', { file, change: text.slice(0, 200), decision: d.id }, 'breaks', source, p),
    }));
  }

  // ---- 9. should Alfred speak up in a room? -------------------------------
  //
  // Calling an LLM into a conversation costs tokens and attention, and one that
  // chimes in on every message is noise. Julia-1 reads the thread and answers
  // four quick questions; an agent is only offered when there is an open
  // question or the room is stuck, an outside answer would help, and it is not
  // just chat. Without Julia-1 there are no offers: @alfred still works.

  async shouldSpeak(roomName, task, thread) {
    if (!thread.length) return { speak: false, source: 'rules' };
    const state = [
      `Team chat in #${roomName}${task ? ` about task ${task.id}: ${task.title}` : ''}.`,
      ...thread.map((m) => `${m.who}: ${m.text}`),
    ].join('\n').slice(-2500);
    const ps = await this.yesno(state, [
      'Is there a question in this conversation that nobody has answered yet?',
      'Are the people in this conversation stuck, unsure or going in circles?',
      'Would a short outside answer with facts or a concrete suggestion help this conversation right now?',
      'Is this conversation only social chat or status updates?',
    ], 'speak');
    if (!ps) return { speak: false, source: 'rules' };
    const [open, stuck, helps, chatter] = ps.map((x) => x ?? 0);
    const speak = helps >= SPEAK_BAR && Math.max(open, stuck) >= 0.6 && chatter < 0.5;
    const p = Math.round(Math.min(helps, Math.max(open, stuck)) * 100) / 100;
    const reason = open >= stuck ? 'open question' : 'room looks stuck';
    const logId = this.log('speak', { room: roomName, last: thread.at(-1)?.text.slice(0, 160), open, stuck, helps, chatter }, speak ? 'speak' : 'quiet', 'alfred', p);
    return { speak, p, reason, source: 'alfred', logId };
  }

  // ---- 4. route a request to the right teammate --------------------------------

  async route(text, people) {
    if (!people.length) return null;
    // profiles include each person's recent changes, so code questions find the code's owner
    const n = await this.narrow(text, people, 4, 15, (x) => x.profile, 'route');
    const cands = n.items;
    let pick = null, source = 'rules', p = null;
    const top = await this.choose(`Request: ${text.slice(0, 500)}`, 'Which teammate is best placed to handle this request?',
      cands.map((x) => ({ key: x.id, desc: x.profile })), 'route');
    if (top) { source = 'alfred'; p = top.p; pick = cands.find((x) => x.id === top.choice) || null; }
    if (!pick) {
      const best = cands.map((x) => ({ x, s: overlap(text, x.profile) })).sort((a, b) => b.s - a.s)[0];
      pick = best?.s > 0 ? best.x : null; p = best?.s ?? null; source = top ? 'alfred+rules' : 'rules';
    }
    if (n.embedded) source = `embed+${source}`;
    const id = this.log('route', { text: text.slice(0, 200), candidates: cands.map((x) => x.id) }, pick?.id ?? 'none', source, p);
    return pick ? { person: pick, p, source, decisionId: id } : null;
  }

  // ---- 5. link a commit to a card ------------------------------------------------

  async linkCommit(subject, branch, tasks) {
    const byBranch = tasks.find((t) => t.branch && branch && t.branch === branch);
    if (byBranch) return { task: byBranch, source: 'branch' };
    if (!tasks.length) return null;
    let pick = null, source = 'rules', p = null;
    const n = await this.narrow(subject, tasks, 6, 12, (t) => t.title, 'commit');
    const top = await this.choose(`Commit: ${subject}${branch ? ` (branch ${branch})` : ''}`, 'Which task does this commit belong to?',
      [...n.items.map((t) => ({ key: t.id, desc: t.title })), { key: 'none', desc: 'None of these' }], 'commit');
    if (top) { source = 'alfred'; p = top.p; pick = top.choice !== 'none' && (Number.isNaN(top.p) || top.p >= 0.5) ? tasks.find((t) => t.id === top.choice) : null; }
    else {
      const best = tasks.map((t) => ({ t, s: overlap(subject, t.title) })).sort((a, b) => b.s - a.s)[0];
      pick = best && best.s >= 0.34 ? best.t : tasks.length === 1 ? tasks[0] : null; p = best?.s ?? null;
    }
    const id = this.log('commit', { subject: subject.slice(0, 200), branch, candidates: tasks.map((t) => t.id) }, pick?.id ?? 'none', source, p);
    return pick ? { task: pick, p, source, decisionId: id } : null;
  }

  // ---- 6. stale or paused ----------------------------------------------------------

  async pausedOrAbandoned(task, ownerMessages) {
    const recent = ownerMessages.slice(-5).map((m) => m.text).join('\n');
    if (!recent) return { paused: false, source: 'rules' };
    let paused = false, source = 'rules', p = null;
    const ps = await this.yesno(`Task: ${task.title}\nOwner's latest messages:\n${recent.slice(0, 900)}`,
      ['Did the owner say they paused this task and will come back to it later?'], 'stale');
    if (ps) { source = 'alfred'; p = ps[0]; paused = (p ?? 0) >= 0.5; }
    else paused = /\b(back (on|monday|tomorrow|next)|pausing|paused|on hold|ooo|out of office|vacation|pick (it|this) up|after (the|my)|later this week|blocked on)\b/i.test(recent);
    const id = this.log('stale', { task: task.id, messages: recent.slice(0, 300) }, paused ? 'paused' : 'abandoned', source, p);
    return { paused, p, source, decisionId: id };
  }

  // ---- 7. handoff completeness ----------------------------------------------------

  async handoffGaps(summary, todos) {
    const text = `${summary}\n${(todos || []).map((t) => `- ${t}`).join('\n')}`;
    const checks = [
      ['done', 'Does this handoff say what is already done?', /\b(done|finished|implemented|added|works|merged|built|completed|shipped)\b/i],
      ['left', 'Does this handoff say what is still left to do?', /\b(left|remaining|todo|to do|next|still need|missing|not yet|pending)\b/i],
      ['test', 'Does this handoff say how to test or verify the work?', /\b(test|verify|check|run|repro|try it|npm|pytest|go test|cargo)\b/i],
    ];
    let source = 'rules';
    const ps = await this.yesno(text.slice(0, 1500), checks.map((c) => c[1]), 'handoff');
    let present;
    if (ps) { source = 'alfred'; present = ps.map((p) => (p ?? 1) >= 0.5); }
    else present = checks.map((c, i) => c[2].test(text) || (c[0] === 'left' && (todos || []).length > 0));
    const missing = checks.filter((_, i) => !present[i]).map((c) => c[0]);
    const id = this.log('handoff', { summary: summary.slice(0, 300), todos: (todos || []).length }, missing.join(',') || 'complete', source);
    return { missing, source, decisionId: id };
  }

  // ---- 8. which events are worth a toast ----------------------------------------

  async worthToast(me, myTask, items) {
    if (!items.length) return [];
    const rules = items.map((it) => it.kind === 'request' || it.kind === 'handoff' || (it.kind === 'decision' && (it.room === 'team' || it.room === myTask?.room)) || (it.kind === 'guard'));
    const ps = await this.yesno(`Developer ${me}${myTask ? ` is working on ${myTask.id}: ${myTask.title}` : ''}.`,
      items.map((it) => `Is this worth interrupting the developer right now: ${it.text.slice(0, 240)}?`), 'toast');
    const keep = ps ? items.map((it, i) => it.kind === 'request' || it.kind === 'handoff' || (ps[i] ?? 0) >= 0.5) : rules;
    this.log('toast', { items: items.map((it) => `${it.kind}:${it.text.slice(0, 60)}`) }, keep.map((k) => (k ? 1 : 0)).join(''), ps ? 'alfred' : 'rules');
    return keep;
  }
}
