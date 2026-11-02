// Copyright 2026 Aman Solanki
// SPDX-License-Identifier: MIT
//
// Batcave mod for Claude Code: the team, inside your session.
//
// ui.render (AbovePrompt): a live team band above the prompt: who is online,
//   what teammates' agents are doing, requests waiting for you, your claim,
//   tokens saved, with Board, Team and Requests buttons.
// ui.render (Pane): the Batcave pane, opened with /cave or a band button, with
//   four tabs: Board (claim from it), Team, Requests (Run or Decline) and Stats.
// tool.call (Edit, Write, MultiEdit, NotebookEdit): the guard. If another
//   teammate's agent edited the file recently, hold the edit in a pane with
//   Proceed and Cancel. Cancel returns { deny } with the reason.
// session.start: read ~/.batcave/config.json, register /cave, start polling.
// clock.every: refresh the team state; toast new requests, handoffs and decisions.
//
// Presence, activity and context injection stay in the plugin's command hooks,
// which every agent shares. This module adds what only a mod can: UI and holds.
//
// The host reads on(...) and $.noun.method(...) from source, so they are
// spelled literally, and helpers that take $ are top-level functions.

const PANE_ID = "batcave";
const GUARD_ID = "batcave-guard";
const POLL_MS = 15000;
const HOLD_LIMIT_MS = 10 * 60 * 1000;
const POLL_SECONDS = "0.25";
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const TABS = ["Board", "Room", "Team", "Requests", "Stats"];
const LANES = [["backlog", "Backlog"], ["claimed", "Claimed"], ["running", "Running"], ["review", "Review"], ["done", "Done"]];

const state = {
  cfg: null,          // { url, token, user, name }
  root: "",           // git root of the session, for repo-relative paths
  team: null,         // last /api/state
  stats: null,        // last /api/stats
  error: "",          // last connection problem, shown in the band
  tab: 0,
  paneOpen: false,
  paneInBand: false,
  seen: { requests: new Set(), handoffs: new Set(), decisions: new Set(), invites: new Set() },
  sync: null,         // { room, name, branch, onBranch, behind: [pushes] } for the room you work in
  invoked: new Set(), // @alfred requests this session already took
  busy: false,        // a main-loop turn is running; Alfred waits for it to end
  primed: false,
  held: null,         // guard hold: { file, touches, decision }
  timer: null,
};

export function register(on) {
  on("session.start", async ($, e, next) => {
    const result = await next(e);
    await loadConfig($);
    await $.command.register({ name: "cave", description: "Batcave: the team board, people, requests and stats" });
    await refresh($);
    if (state.timer === null) {
      state.timer = $.clock.every(POLL_MS, () => refresh($));
    }
    return result;
  });

  on("command.run", { command: "cave" }, async ($, e) => {
    const arg = String(e.args ?? e.argument ?? "").trim().toLowerCase();
    const tab = Math.max(0, TABS.findIndex((t) => t.toLowerCase() === arg));
    await openPane($, tab);
    return { text: state.cfg ? `Batcave · ${TABS[state.tab]}` : "Batcave is not set up. Run /batcave:setup." };
  });

  on("turn.start", async ($, e, next) => {
    if (!e.agentId) state.busy = true;
    return next(e);
  });

  on("turn.complete", async ($, e, next) => {
    const result = await next(e);
    if (!e.agentId) { state.busy = false; await refresh($); }
    return result;
  });

  // The guard: hold an edit to a file a teammate's agent touched recently.
  on("tool.call", async ($, e, next) => {
    if (!EDIT_TOOLS.has(e.tool) || state.cfg === null) {
      return next(e);
    }
    const file = relPath(state.root, e.file_path ?? e.notebook_path);
    let touches = [];
    let verdict = null;
    const hint = String(e.new_string ?? e.content ?? e.new_source ?? (Array.isArray(e.edits) ? e.edits.map((x) => x.new_string ?? "").join("\n") : "")).slice(0, 600);
    try {
      const branch = await gitOut($, ["rev-parse", "--abbrev-ref", "HEAD"]);
      const g = await api($, "GET", `/api/guard?files=${encodeURIComponent(file)}${hint ? `&change=${encodeURIComponent(hint)}` : ""}&branch=${encodeURIComponent(branch)}`);
      touches = g && g.conflict ? g.touches : [];
      verdict = g;
    } catch {
      return next(e); // fail open: a missing server never blocks an edit
    }
    const breaks = verdict?.breaks ?? [];
    const slices = verdict?.slices ?? [];
    const behind = [];
    for (const p of (verdict?.upstream ?? []).slice(0, 5)) {
      if (!(await hasCommit($, p.sha))) behind.push(p);
    }
    if (touches.length > 0 && verdict.severity === "low") {
      // Alfred judged the overlap trivial: mention it, and only hold for a broken decision
      $.ui.toast(`Batcave · ${touches[0].name} also touched ${file}; overlap looks trivial`);
      touches = [];
    }
    if (touches.length === 0 && breaks.length === 0 && slices.length === 0 && behind.length === 0) {
      return next(e);
    }
    while (state.held !== null) {
      if (next.signal.aborted) return { deny: "Batcave held this edit: the turn was interrupted. Do not retry unless the user asks." };
      await $.process.run(["sleep", POLL_SECONDS], { timeoutMs: 5000 });
    }
    const mine = { file, touches, breaks, slices, behind, decision: null, where: "pane" };
    state.held = mine;
    let opened = { isPlaced: false };
    try {
      opened = await $.ui.open({ id: GUARD_ID, title: "Batcave guard", focus: true, rows: 9 + Math.min(4, touches.length) + Math.min(3, breaks.length) * 2 + Math.min(2, slices.length) + Math.min(2, behind.length) });
      mine.where = opened.isPlaced ? "pane" : "band";
      $.ui.invalidate("ui.render");
      const startedAt = await $.clock.now();
      while (mine.decision === null) {
        if (next.signal.aborted) { mine.decision = "interrupted"; break; }
        if ((await $.clock.now()) - startedAt > HOLD_LIMIT_MS) { mine.decision = "timeout"; break; }
        await $.process.run(["sleep", POLL_SECONDS], { timeoutMs: 5000 });
      }
    } catch {
      mine.decision = mine.decision ?? "proceed"; // a UI failure must not block work
    } finally {
      try { if (opened.isPlaced) await $.ui.close({ id: GUARD_ID }); } catch { /* already closed */ }
      if (state.held === mine) state.held = null;
      $.ui.invalidate("ui.render");
    }
    if (mine.decision === "pull") {
      mine.pulled = await pullBranch($);
    }
    if (mine.decision === "proceed" || mine.decision === "cancel") {
      const outcomes = [];
      if (verdict.decisionId && touches.length) outcomes.push([verdict.decisionId, mine.decision === "proceed" ? "proceeded-real" : "cancelled-real"]);
      for (const b of breaks) outcomes.push([b.logId, mine.decision === "proceed" ? "overridden" : "accepted"]);
      for (const [id, outcome] of outcomes) {
        try { await api($, "POST", "/api/feedback", { id, outcome }); } catch { /* best effort */ }
      }
    }
    if (mine.decision === "proceed") {
      return next(e);
    }
    const why = { cancel: "the user chose Cancel", timeout: "no answer within 10 minutes", interrupted: "the turn was interrupted" }[mine.decision] ?? "no answer";
    const reasons = [];
    if (touches.length) reasons.push(`${touches.map((t) => `${t.name}'s agent (${t.task ?? "no task"})`).join(", ")} edited it recently`);
    if (breaks.length) reasons.push(`it breaks the team decision ${breaks.map((b) => `"${b.text}" (D-${b.id})`).join(" and ")}`);
    if (behind.length) reasons.push(`${behind.map((p) => p.name).join(" and ")} pushed a newer version to the shared branch`);
    if (slices.length) reasons.push(`it is in ${slices.map((x) => `${x.name}'s slice (${x.slice})`).join(" and ")} of #${slices[0].roomName}`);
    if (mine.decision === "pull") {
      return { deny: `Batcave pulled the latest shared branch before this edit to ${file}${mine.pulled ? "" : ", but the pull needs attention: finish it first (resolve conflicts, then git rebase --continue)"}. Re-read ${file} and redo the change on top of ${behind.map((p) => p.name).join(" and ")}'s work.` };
    }
    const fix = slices.length
      ? `Ask ${slices[0].name} in #${slices[0].roomName} before changing their slice, or ask the user. Do not retry unless the user asks.`
      : breaks.length && !touches.length
        ? "Rework the change so it follows the decision, or ask the user whether the decision should change."
        : "Coordinate with them first (batcave_say in their task room, or batcave_request). Do not retry unless the user asks.";
    return { deny: `Batcave guard held this edit to ${file}: ${reasons.join(", and ")}, and ${why}. ${fix}` };
  });

  on("ui.render", { component: "AbovePrompt" }, ($, e, next) => {
    if (e.hasSurvey) return next(e);
    const t = $.ui.resolve(e);
    if (state.held !== null && state.held.where === "band") return guardView(t, state.held);
    if (state.paneOpen && state.paneInBand) return paneView($, t, e, true);
    if (state.cfg === null) return next(e);
    return band($, t, e.bodyColumns ?? 80);
  });

  on("ui.render", { component: "Pane" }, ($, e, next) => {
    if (e.requestId === GUARD_ID && state.held !== null) return guardView($.ui.resolve(e), state.held);
    if (e.requestId === PANE_ID) return paneView($, $.ui.resolve(e), e, false);
    return next(e);
  });

  on("ui.close", ($, e, next) => {
    if (e.id === PANE_ID || e.requestId === PANE_ID) { state.paneOpen = false; state.paneInBand = false; }
    $.ui.invalidate("ui.render");
    return next(e);
  });
}

// ---- data -------------------------------------------------------------------

async function loadConfig($) {
  try {
    const script = 'cat "${BATCAVE_HOME:-$HOME/.batcave}/config.json" 2>/dev/null || echo "{}"; printf "\\n%s\\n%s\\n%s\\n" "$BATCAVE_URL" "$BATCAVE_TOKEN" "$BATCAVE_USER"; git rev-parse --show-toplevel 2>/dev/null';
    const cwd = await $.session.cwd();
    const run = await $.process.run(["sh", "-c", script], { cwd, timeoutMs: 5000 });
    const lines = run.stdout.split("\n");
    const jsonEnd = lines.findIndex((l) => l.trim().endsWith("}"));
    const json = JSON.parse(lines.slice(0, jsonEnd + 1).join("\n") || "{}");
    const [envUrl, envToken, envUser, root] = lines.slice(jsonEnd + 1);
    const cfg = {
      url: String(envUrl || json.url || "").replace(/\/+$/, ""),
      token: envToken || json.token || "",
      user: String(envUser || json.user || "").toLowerCase(),
      name: json.name || "",
    };
    state.cfg = cfg.url && cfg.user ? cfg : null;
    state.root = (root || cwd || "").trim();
  } catch {
    state.cfg = null;
  }
}

async function api($, method, route, body) {
  const c = state.cfg;
  const res = await $.http.fetch(c.url + route, {
    method,
    headers: {
      "content-type": "application/json",
      "x-batcave-user": c.user,
      "x-batcave-name": encodeURIComponent(c.name || c.user),
      ...(c.token ? { authorization: `Bearer ${c.token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json = res.text ? JSON.parse(res.text) : {};
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}

async function refresh($) {
  if (state.cfg === null) return;
  try {
    const [team, stats] = await Promise.all([api($, "GET", "/api/state"), api($, "GET", "/api/stats").catch(() => null)]);
    state.team = team;
    state.stats = stats;
    state.error = "";
    await announce($, team);
    state.sync = await syncState($, team);
    await runAsked($, team);
    await $.process.run(["sh", "-c", 'd="${BATCAVE_HOME:-$HOME/.batcave}"; mkdir -p "$d" && date +%s > "$d/mod-active"'], { timeoutMs: 3000 });
  } catch (err) {
    state.error = String(err?.message ?? err).slice(0, 80);
  }
  $.ui.invalidate("ui.render");
}

// @alfred from this user: hand the room thread to this session's agent at once.
// The user asked for it, so there is nothing to confirm. If another session of
// the same user claimed it first, the server says so and this one stays quiet.
async function runAsked($, team) {
  if (state.busy) return; // never cut into a running turn; the next turn.complete picks it up
  const me = state.cfg.user;
  for (const r of team.requests.filter((x) => x.to === me && x.kind === "alfred" && x.auto && !state.invoked.has(x.id))) {
    state.invoked.add(r.id);
    try {
      await api($, "POST", `/api/requests/${r.id}/resolve`, { action: "accept" });
    } catch {
      continue;
    }
    $.ui.toast(r.autoBy === "setting" ? `Batcave · Alfred brought your agent into #${r.room}` : `Batcave · @alfred: your agent is answering in #${r.room}`);
    await $.prompt.submit({ text: r.brief });
  }
}

// Toast what is new for this user since the last poll. The first poll only primes.
async function announce($, team) {
  const me = state.cfg.user;
  const fresh = [];
  for (const r of team.requests.filter((x) => x.to === me && !(x.kind === "alfred" && x.auto))) {
    if (state.seen.requests.has(r.id)) continue;
    state.seen.requests.add(r.id);
    const text = r.kind === "alfred" ? `Alfred: ${r.text} Press w.` : `${nameOf(r.from)} asked your agent: ${r.text}`;
    fresh.push({ kind: "request", text, room: r.room });
  }
  for (const h of team.handoffs.filter((x) => x.to === me)) {
    if (!state.seen.handoffs.has(h.id)) { state.seen.handoffs.add(h.id); fresh.push({ kind: "handoff", text: `${nameOf(h.from)} handed you ${h.task}`, room: "" }); }
  }
  for (const r of team.rooms.filter((x) => x.invites?.[me])) {
    const key = `${r.id}:${r.invites[me].at}`;
    if (!state.seen.invites.has(key)) { state.seen.invites.add(key); fresh.push({ kind: "request", text: `${nameOf(r.invites[me].by)} added you to #${r.name}`, room: r.id }); }
  }
  for (const d of team.decisions) {
    if (!state.seen.decisions.has(d.id)) { state.seen.decisions.add(d.id); if (d.author !== me) fresh.push({ kind: "decision", text: `New decision from ${nameOf(d.author)}: ${d.text}`, room: d.room }); }
  }
  const primed = state.primed;
  state.primed = true;
  if (!primed || fresh.length === 0) return;
  // Alfred use 8: only interrupt for what matters to me right now
  let keep = fresh.map(() => true);
  try {
    const r = await api($, "POST", "/api/notify-filter", { items: fresh });
    if (Array.isArray(r?.keep) && r.keep.length === fresh.length) keep = r.keep;
  } catch { /* keep everything */ }
  for (const item of fresh.filter((_, i) => keep[i]).slice(0, 3)) $.ui.toast(`Batcave · ${item.text.slice(0, 140)}`);
}

async function openPane($, tab) {
  state.tab = tab;
  state.paneOpen = true;
  await refresh($);
  const placed = await $.ui.open({ id: PANE_ID, title: "Batcave", focus: true, closeOnEscape: true, rows: 22, columns: 64 });
  state.paneInBand = placed?.isPlaced === false;
  $.ui.invalidate("ui.render");
}

async function claim($, id) {
  try {
    const r = await api($, "POST", `/api/tasks/${encodeURIComponent(id)}/claim`, {});
    $.ui.toast(`Batcave · claimed ${r.task.id}, branch ${r.task.branch}`);
    await $.prompt.submit({ text: `I claimed ${r.task.id} "${r.task.title}" in Batcave. Create and switch to branch ${r.task.branch} (stash or ask first if the tree is dirty), then summarize the task and the team decisions that apply.` });
  } catch (err) {
    $.ui.toast(`Batcave · could not claim ${id}: ${String(err?.message ?? err).slice(0, 100)}`);
  }
  await refresh($);
}

async function answer($, req, action) {
  try {
    await api($, "POST", `/api/requests/${req.id}/resolve`, { action });
    if (action === "accept") {
      await $.prompt.submit({ text: req.brief ?? `Teammate request R-${req.id} from ${nameOf(req.from)}, which I accepted in Batcave: ${req.text}` });
    } else {
      $.ui.toast(`Batcave · declined R-${req.id}`);
    }
  } catch (err) {
    $.ui.toast(`Batcave · ${String(err?.message ?? err).slice(0, 120)}`);
  }
  await refresh($);
}

// The room you work in: the one you joined last, else your active task's.
function focusRoom(team) {
  const me = state.cfg.user;
  const p = team.people.find((x) => x.id === me);
  const joined = p?.room && team.rooms.find((r) => r.id === p.room && r.members?.includes(me));
  if (joined) return joined;
  const t = team.tasks.find((x) => x.owner === me && (x.status === "claimed" || x.status === "running"));
  return t ? team.rooms.find((r) => r.id === t.room) ?? null : null;
}

// Is this checkout behind teammates' pushes to the room's branch? Checked locally, no fetch.
async function syncState($, team) {
  const room = focusRoom(team);
  if (!room?.branch) return room ? { room: room.id, name: room.name, branch: null, onBranch: false, behind: [] } : null;
  const branch = await gitOut($, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const behind = [];
  if (branch === room.branch) {
    for (const p of (room.pushes ?? []).filter((x) => x.by !== state.cfg.user).slice(-5)) {
      if (!(await hasCommit($, p.sha))) behind.push(p);
    }
  }
  return { room: room.id, name: room.name, branch: room.branch, onBranch: branch === room.branch, behind };
}

// ---- git, in the session's checkout -------------------------------------------

async function gitOut($, args) {
  try {
    const r = await $.process.run(["git", ...args], { cwd: state.root || undefined, timeoutMs: 3000 });
    return r.exitCode === 0 ? String(r.stdout).trim() : "";
  } catch {
    return "";
  }
}

// Is this commit already in the local checkout? Unknown commits count as no.
async function hasCommit($, sha) {
  try {
    const r = await $.process.run(["git", "merge-base", "--is-ancestor", sha, "HEAD"], { cwd: state.root || undefined, timeoutMs: 3000 });
    return r.exitCode === 0;
  } catch {
    return true; // cannot tell: do not hold the edit for it
  }
}

async function pullBranch($) {
  const r = await $.process.run(["git", "pull", "--rebase", "--autostash"], { cwd: state.root || undefined, timeoutMs: 60000 });
  if (r.exitCode === 0) {
    $.ui.toast("Batcave · pulled the shared branch");
    await refresh($);
    return true;
  }
  $.ui.toast("Batcave · pull needs attention; asking Claude to finish it");
  await $.prompt.submit({ text: `Batcave tried to pull the room's shared branch and git said:\n${String(r.stderr || r.stdout).slice(0, 800)}\nFinish the pull (resolve conflicts if any, keep both sides' intent), then summarize what changed upstream.` });
  return false;
}

async function setAuto($, on) {
  try {
    await api($, "POST", "/api/presence", { autoWeighIn: on });
    $.ui.toast(on ? "Batcave · auto weigh-in on: Alfred can bring your agent into rooms" : "Batcave · auto weigh-in off: Alfred will ask first");
  } catch (err) {
    $.ui.toast(`Batcave · ${String(err?.message ?? err).slice(0, 100)}`);
  }
  await refresh($);
}

// ---- drawing ----------------------------------------------------------------
//
// The look: the Grid, quietly. Hairline frames, one cool accent for "live",
// one warm accent for "needs you", everything else muted. No blocks of color.

const C = {
  fg: "#D3DCE0",     // primary text
  mut: "#8597A0",    // secondary text
  dim: "#4D5D66",    // labels, separators
  line: "#2B3B43",   // frames and rules
  cy: "#7CCFDC",     // live: running agents, focus, your claim
  amb: "#D6A160",    // needs you: requests, review, held edits
  ok: "#8DC5A0",     // online
  warn: "#D7896C",   // guard
};
const PANE_W = 60;
const GLYPH = { backlog: "○", claimed: "◇", running: "◆", review: "◈", done: "·" };
const TONE = { backlog: C.mut, claimed: C.fg, running: C.cy, review: C.amb, done: C.dim };

function sep(Text, key) {
  return Text({ key, color: C.line, children: " │ " });
}

// "── LABEL ───────────── 03": a section rule with a right-aligned count
function rule(Text, key, label, count, width) {
  const tail = count === undefined ? "" : ` ${String(count).padStart(2, "0")}`;
  const fill = Math.max(2, width - label.length - tail.length - 4);
  return Text({ key, children: [
    Text({ key: "a", color: C.line, children: "── " }),
    Text({ key: "b", color: C.mut, children: label }),
    Text({ key: "c", color: C.line, children: ` ${"─".repeat(fill)}` }),
    Text({ key: "d", color: C.dim, children: tail }),
  ] });
}

function fit(text, n) {
  const s = String(text ?? "");
  return s.length > n ? `${s.slice(0, Math.max(0, n - 1))}…` : s.padEnd(n);
}

function band($, t, columns) {
  const { Box, Text, Button } = t;
  if (state.error) {
    return Box({ flexDirection: "row", paddingX: 1, children: [
      Text({ key: "m", color: C.line, children: "▍" }),
      Text({ key: "n", color: C.mut, children: "batcave" }),
      sep(Text, "s"),
      Text({ key: "e", color: C.warn, children: "offline" }),
      Text({ key: "d", color: C.dim, wrap: "truncate-end", children: `  ${state.error}` }),
    ] });
  }
  const team = state.team;
  if (!team) return Box({ paddingX: 1, children: [Text({ color: C.dim, children: "▍batcave · connecting" })] });
  const me = state.cfg.user;
  const online = team.people.filter((p) => p.presence !== "offline" && p.presence !== "away").length;
  const reqs = team.requests.filter((r) => r.to === me && r.kind !== "alfred").length;
  const offer = team.requests.filter((r) => r.to === me && r.kind === "alfred" && !r.auto).at(-1);
  const mine = team.tasks.find((x) => x.owner === me && (x.status === "claimed" || x.status === "running"));
  const busy = team.people.filter((p) => p.id !== me && p.presence === "agent running").slice(0, columns >= 150 ? 2 : 1);
  const saved = state.stats?.tokens?.saved ?? 0;
  const suggestion = mine ? null : team.people.find((p) => p.id === me)?.suggestion;

  const parts = [
    Text({ key: "m", color: C.cy, children: "▍" }),
    Text({ key: "n", color: C.cy, children: "batcave " }),
    Text({ key: "t", color: C.fg, children: team.team }),
    sep(Text, "s1"),
    Text({ key: "o", color: C.ok, children: "● " }),
    Text({ key: "on", color: C.mut, children: `${online} online` }),
  ];
  if (reqs) parts.push(sep(Text, "s2"), Text({ key: "req", color: C.amb, children: `${reqs} request${reqs > 1 ? "s" : ""}` }));
  const sync = state.sync;
  if (sync?.behind.length) parts.push(sep(Text, "s6"), Text({ key: "sync", children: [Text({ key: "a", color: C.mut, children: `#${sync.name} ` }), Text({ key: "b", color: C.amb, children: `↓${sync.behind.length} · ${[...new Set(sync.behind.map((p) => nameOf(p.by).toLowerCase()))].join(", ")} pushed` })] }));
  if (offer) parts.push(sep(Text, "s5"), Text({ key: "offer", children: [Text({ key: "a", color: C.dim, children: "alfred › " }), Text({ key: "b", color: C.amb, children: `#${offer.room} could use your agent` })] }));
  parts.push(sep(Text, "s3"));
  if (suggestion) {
    parts.push(Text({ key: "mine", color: C.mut, children: [Text({ key: "a", color: C.dim, children: "looks like " }), Text({ key: "b", color: C.cy, children: suggestion.task }), Text({ key: "c", children: ` ${fit(suggestion.title, 40).trimEnd()}` })] }));
  } else if (mine) {
    parts.push(Text({ key: "mine", children: [Text({ key: "g", color: TONE[mine.status], children: `${GLYPH[mine.status]} ` }), Text({ key: "i", color: C.fg, children: mine.id }), Text({ key: "s", color: C.mut, children: ` ${mine.status}` })] }));
  } else {
    parts.push(Text({ key: "mine", color: C.dim, children: "no claim" }));
  }
  // optional segments, added while they fit: teammates' agents, then savings
  const buttonCols = (suggestion ? 14 : 0) + (offer ? 14 : 0) + (sync?.behind.length ? 8 : 0) + 18 + (reqs ? 12 : 0);
  let used = 30 + (reqs ? 13 : 0) + (offer ? 24 + offer.room.length : 0) + (suggestion ? 14 + suggestion.title.length : mine ? 16 : 11);
  for (const p of busy) {
    const now = fit(p.now || "working", 30).trimEnd();
    const len = 3 + p.name.length + 3 + now.length;
    if (used + len > columns - buttonCols) break;
    used += len;
    parts.push(sep(Text, `s-${p.id}`), Text({ key: `b-${p.id}`, children: [Text({ key: "n", color: C.cy, children: p.name.toLowerCase() }), Text({ key: "a", color: C.dim, children: " › " }), Text({ key: "w", color: C.mut, children: now })] }));
  }
  if (saved && used + 18 <= columns - buttonCols) parts.push(sep(Text, "s4"), Text({ key: "saved", color: C.dim, children: `${short(saved)} tok saved` }));

  const buttons = columns >= 90 ? [
    ...(sync?.behind.length ? [Button({ key: "pull", label: "pull", hotkey: "p", variant: offer || suggestion ? "secondary" : "primary", onPress: () => pullBranch($) })] : []),
    ...(offer ? [Button({ key: "offer", label: "weigh in", hotkey: "w", variant: "primary", onPress: () => answer($, offer, "accept") })] : []),
    ...(suggestion ? [Button({ key: "suggest", label: `claim ${suggestion.task}`, hotkey: "c", variant: suggestion && !offer ? "primary" : "secondary", onPress: () => claim($, suggestion.task) })] : []),
    Button({ key: "board", label: "board", hotkey: "b", plain: true, dimColor: true, onPress: () => openPane($, 0) }),
    Button({ key: "team", label: "team", hotkey: "t", plain: true, dimColor: true, onPress: () => openPane($, 2) }),
    ...(reqs ? [Button({ key: "requests", label: "requests", hotkey: "q", plain: true, onPress: () => openPane($, 3) })] : []),
  ] : [];
  return Box({ flexDirection: "row", paddingX: 1, gap: 2, children: [Box({ key: "line", flexDirection: "row", flexShrink: 1, children: parts }), ...buttons] });
}

function paneView($, t, e, inBand) {
  const { Box, Text, Button } = t;
  const tabs = TABS.map((name, i) => Button({
    key: `tab-${i}`, label: name.toLowerCase(), hotkey: String(i + 1), plain: true, dimColor: i !== state.tab, autoFocus: i === state.tab,
    onPress: () => { state.tab = i; $.ui.invalidate("ui.render"); },
  }));
  const close = () => {
    state.paneOpen = false;
    if (!state.paneInBand) $.ui.close({ id: PANE_ID });
    state.paneInBand = false;
    $.ui.invalidate("ui.render");
  };
  const width = Math.min(PANE_W, Math.max(40, (e.bodyColumns ?? e.columns ?? PANE_W + 4) - 4));
  let body;
  if (!state.team) body = [Text({ key: "x", color: C.dim, children: state.error || "loading" })];
  else if (state.tab === 0) body = boardTab($, t, inBand ? Math.max(4, (e.maxRows || 16) - 6) : 14, width);
  else if (state.tab === 1) body = roomTab($, t, width);
  else if (state.tab === 2) body = teamTab($, t, width);
  else if (state.tab === 3) body = requestsTab($, t, width);
  else body = statsTab(t, width);
  return Box({
    flexDirection: "column", borderStyle: "single", borderColor: C.line, paddingX: 1,
    children: [
      Box({ key: "head", flexDirection: "row", justifyContent: "space-between", children: [
        Text({ key: "title", children: [
          Text({ key: "m", color: C.cy, children: "▍batcave" }),
          Text({ key: "s", color: C.line, children: " // " }),
          Text({ key: "t", color: C.mut, children: state.team?.team ?? "" }),
        ] }),
        Button({ key: "close", label: "close", hotkey: "x", plain: true, dimColor: true, onPress: close }),
      ] }),
      Box({ key: "tabs", flexDirection: "row", gap: 2, children: tabs }),
      Text({ key: "rule", color: C.line, children: "─".repeat(width) }),
      Box({ key: "body", flexDirection: "column", children: body }),
    ],
  });
}

function boardTab($, t, rows, width) {
  const { Box, Text, Button } = t;
  const out = [];
  let hot = 0;
  const me = state.cfg.user;
  for (const [status, label] of LANES) {
    const all = state.team.tasks.filter((x) => x.status === status);
    const list = all.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, status === "done" ? 2 : 4);
    out.push(rule(Text, `h-${status}`, label.toUpperCase(), all.length, width));
    if (!list.length) out.push(Text({ key: `e-${status}`, color: C.dim, children: "   ·" }));
    for (const task of list) {
      const owner = task.owner ? (task.owner === me ? "you" : nameOf(task.owner).toLowerCase()) : "";
      const flag = task.paused ? "paused" : task.stale ? "stale" : task.duplicateOf ? `dup ${task.duplicateOf.task}` : "";
      const titleW = Math.max(12, width - 30);
      const row = [Text({ key: "t", wrap: "truncate-end", children: [
        Text({ key: "g", color: TONE[status], children: ` ${GLYPH[status]} ` }),
        Text({ key: "i", color: task.owner === me ? C.cy : C.dim, children: fit(task.id, 6) }),
        Text({ key: "n", color: status === "done" ? C.dim : C.fg, children: fit(task.title, titleW) }),
        Text({ key: "o", color: C.mut, children: ` ${fit(owner, 9)}` }),
        Text({ key: "f", color: task.stale ? C.warn : C.dim, children: flag ? ` ${flag}` : "" }),
      ] })];
      if ((status === "backlog" || task.stale) && hot < 9) {
        hot += 1;
        row.push(Button({ key: "c", label: task.stale ? "take over" : "claim", hotkey: String.fromCharCode(96 + hot), plain: true, dimColor: true, onPress: () => claim($, task.id) }));
      }
      out.push(Box({ key: `r-${task.id}`, flexDirection: "row", justifyContent: "space-between", children: row }));
    }
  }
  return out.slice(0, rows + 5);
}

function roomTab($, t, width) {
  const { Box, Text, Button } = t;
  const room = focusRoom(state.team);
  if (!room) return [
    rule(Text, "h", "ROOM", undefined, width),
    Text({ key: "n", color: C.dim, children: "   not in a room yet" }),
    Text({ key: "m", color: C.dim, children: "   claim a card, or: batcave room join <room> [--slice 'src/x/**']" }),
  ];
  const me = state.cfg.user;
  const sync = state.sync;
  const out = [rule(Text, "h", `#${room.name}`.toUpperCase(), room.members.length, width)];
  const status = !room.branch ? Text({ key: "s", color: C.dim, children: "no shared branch yet" })
    : !sync?.onBranch ? Text({ key: "s", color: C.dim, children: "this checkout is on another branch" })
      : sync.behind.length ? Text({ key: "s", color: C.amb, children: `↓${sync.behind.length} behind` })
        : Text({ key: "s", color: C.ok, children: "up to date" });
  out.push(Box({ key: "br", flexDirection: "row", justifyContent: "space-between", children: [
    Text({ key: "l", wrap: "truncate-end", children: [Text({ key: "a", color: C.mut, children: " branch " }), Text({ key: "b", color: C.fg, children: room.branch ?? "-" }), Text({ key: "c", color: C.line, children: "  " }), status] }),
    ...(sync?.behind.length ? [Button({ key: "p", label: "pull", hotkey: "p", plain: true, onPress: () => pullBranch($) })] : []),
  ] }));
  if (room.tasks?.length) out.push(Text({ key: "cards", children: [Text({ key: "a", color: C.mut, children: " cards  " }), Text({ key: "b", color: C.fg, children: room.tasks.join("  ") })] }));
  out.push(rule(Text, "hm", "MEMBERS", undefined, width));
  for (const id of room.members) {
    const p = state.team.people.find((x) => x.id === id);
    const s = room.slices?.[id];
    const live = p && (p.presence === "agent running" ? C.cy : p.presence === "online" ? C.ok : C.dim);
    out.push(Text({ key: `m-${id}`, wrap: "truncate-end", children: [
      Text({ key: "d", color: live || C.dim, children: " ● " }),
      Text({ key: "n", color: C.fg, children: fit(`${p?.name ?? id}${id === me ? " (you)" : ""}`, 15) }),
      Text({ key: "s", color: s ? C.mut : C.dim, children: s ? `${s.name ? `${s.name} · ` : ""}${s.paths.join(" ")}` : "no slice" }),
    ] }));
  }
  const run = Object.entries(room.run ?? {}).filter(([k, v]) => v && (k !== "env" || v.length));
  if (run.length) {
    out.push(rule(Text, "hr", "RUN AND TEST", undefined, width));
    for (const [k, v] of run) out.push(Text({ key: `r-${k}`, wrap: "truncate-end", children: [Text({ key: "a", color: C.dim, children: ` ${fit(k, 8)}` }), Text({ key: "b", color: C.fg, children: Array.isArray(v) ? v.join(" ") : v })] }));
  }
  if (room.rules) {
    out.push(rule(Text, "hu", "RULES", undefined, width));
    for (const [i, line] of room.rules.split("\n").slice(0, 6).entries()) out.push(Text({ key: `u-${i}`, color: C.mut, wrap: "truncate-end", children: ` ${line}` }));
  }
  return out;
}

function teamTab($, t, width) {
  const { Box, Text, Button } = t;
  const order = { "agent running": 0, online: 1, away: 2, offline: 3 };
  const dot = { "agent running": C.cy, online: C.ok, away: C.amb, offline: C.dim };
  const self = state.team.people.find((p) => p.id === state.cfg.user);
  const autoOn = Boolean(self?.autoWeighIn);
  const out = [
    Box({ key: "auto", flexDirection: "row", justifyContent: "space-between", children: [
      Text({ key: "l", children: [
        Text({ key: "a", color: C.mut, children: " auto weigh-in " }),
        Text({ key: "b", color: autoOn ? C.cy : C.dim, children: autoOn ? "on" : "off" }),
        Text({ key: "c", color: C.dim, children: autoOn ? " · Alfred can bring your agent into rooms" : " · Alfred asks first" }),
      ] }),
      Button({ key: "t", label: autoOn ? "turn off" : "turn on", hotkey: "a", plain: true, dimColor: true, onPress: () => setAuto($, !autoOn) }),
    ] }),
    rule(Text, "h", "TEAM", state.team.people.length, width),
  ];
  for (const p of [...state.team.people].sort((a, b) => order[a.presence] - order[b.presence])) {
    const off = p.presence === "offline";
    out.push(Box({ key: p.id, flexDirection: "column", children: [
      Text({ key: "a", wrap: "truncate-end", children: [
        Text({ key: "d", color: dot[p.presence], children: off ? " ○ " : " ● " }),
        Text({ key: "n", color: off ? C.mut : C.fg, children: fit(`${p.name}${p.id === state.cfg.user ? " (you)" : ""}`, 16) }),
        Text({ key: "p", color: p.presence === "agent running" ? C.cy : C.dim, children: fit(p.presence, 14) }),
        Text({ key: "x", color: C.dim, children: `${p.tool ?? ""}${p.autoWeighIn ? " · auto" : ""}` }),
      ] }),
      Box({ key: "b", flexDirection: "row", justifyContent: "space-between", children: [
        Text({ key: "l", wrap: "truncate-end", children: [
          Text({ key: "a", color: C.line, children: "   └ " }),
          Text({ key: "t", color: p.task ? C.mut : C.dim, children: p.task ? `${p.task} · ` : "" }),
          Text({ key: "w", color: off ? C.dim : C.mut, children: fit(p.now || "idle", Math.max(10, width - 32)).trimEnd() }),
        ] }),
        Text({ key: "r", color: C.dim, children: `${p.stats.shipped} shipped · ${p.stats.reviewsOwed} owed` }),
      ] }),
    ] }));
  }
  return out;
}

function requestsTab($, t, width) {
  const { Box, Text, Button } = t;
  const mine = state.team.requests.filter((r) => r.to === state.cfg.user && !(r.kind === "alfred" && r.auto));
  const out = [rule(Text, "h", "REQUESTS FOR YOUR AGENT", mine.length, width)];
  if (!mine.length) return [...out, Text({ key: "none", color: C.dim, children: "   nothing waiting" })];
  mine.slice(0, 5).forEach((r, i) => out.push(Box({
    key: `q-${r.id}`, flexDirection: "column", marginBottom: 1, children: [
      Text({ key: "h", children: [
        Text({ key: "m", color: C.amb, children: " ▍" }),
        Text({ key: "i", color: C.amb, children: `R-${r.id}` }),
        Text({ key: "f", color: C.mut, children: `  from ${nameOf(r.from).toLowerCase()} · ${ago(r.at)}${r.routed ? " · routed" : ""}` }),
      ] }),
      Box({ key: "b", flexDirection: "row", children: [Text({ key: "m", color: C.amb, children: " ▍ " }), Text({ key: "t", color: C.fg, wrap: "wrap", children: r.text })] }),
      Box({ key: "a", flexDirection: "row", gap: 2, marginLeft: 3, children: [
        Button({ key: "run", label: "run on my agent", hotkey: String.fromCharCode(97 + i * 2), variant: "primary", onPress: () => answer($, r, "accept") }),
        Button({ key: "decline", label: "decline", hotkey: String.fromCharCode(98 + i * 2), plain: true, dimColor: true, onPress: () => answer($, r, "decline") }),
      ] }),
    ],
  })));
  return out;
}

function meter(value, max, cells) {
  const n = Math.max(0, Math.min(cells, Math.round((value / Math.max(1, max)) * cells)));
  return { on: "▰".repeat(n), off: "▱".repeat(cells - n) };
}

function statsTab(t, width) {
  const { Text } = t;
  const s = state.stats;
  if (!s) return [Text({ key: "none", color: C.dim, children: "   no stats from the server" })];
  const k = s.tokens;
  const lat = Object.entries(s.latency).filter(([key]) => /^(hook:|alfred:)/.test(key) && !key.endsWith(":failed")).slice(0, 6);
  const max = Math.max(1, ...lat.map(([, v]) => v.p95 || 0));
  const pct = meter(k.savedPct ?? 0, 100, 20);
  const out = [
    rule(Text, "h1", "TOKENS", undefined, width),
    Text({ key: "big", children: [Text({ key: "a", color: C.fg, children: `   ${short(k.saved)}` }), Text({ key: "b", color: C.mut, children: " saved  " }), Text({ key: "c", color: C.cy, children: pct.on }), Text({ key: "d", color: C.line, children: pct.off }), Text({ key: "e", color: C.mut, children: ` ${k.savedPct ?? 0}%` })] }),
    Text({ key: "split", color: C.dim, children: `   dedupe ${short(k.savedDedupe)} · ranking ${short(k.savedRanking)} · sent ${short(k.injected)}` }),
    Text({ key: "sp", children: " " }),
    rule(Text, "h2", "LATENCY  p50 / p95 ms", undefined, width),
    ...lat.map(([key, v]) => {
      const m = meter(v.p95 || 0, max, 14);
      return Text({ key, wrap: "truncate-end", children: [
        Text({ key: "k", color: C.mut, children: `   ${fit(key, 18)}` }),
        Text({ key: "v", color: C.fg, children: `${String(v.p50 ?? "-").padStart(5)} / ${String(v.p95 ?? "-").padEnd(5)} ` }),
        Text({ key: "a", color: C.cy, children: m.on }), Text({ key: "b", color: C.line, children: m.off }),
      ] });
    }),
    Text({ key: "sp2", children: " " }),
    rule(Text, "h3", "ALFRED", undefined, width),
    Text({ key: "alfred", children: s.alfred?.ready
      ? [Text({ key: "a", color: C.ok, children: "   ● " }), Text({ key: "b", color: C.mut, children: `${s.alfred.model} on ${s.alfred.device}` })]
      : [Text({ key: "a", color: C.dim, children: "   ○ " }), Text({ key: "b", color: C.dim, children: "not running · plain rules in use" })] }),
  ];
  const q = Object.entries(s.alfred?.quality ?? {}).filter(([, v]) => v.withOutcome > 0).slice(0, 4);
  for (const [key, v] of q) out.push(Text({ key: `q-${key}`, color: C.dim, children: `     ${fit(key.split(":")[0], 10)} ${String(v.rate ?? "-").padStart(5)}% taken · ${v.withOutcome} outcome${v.withOutcome === 1 ? "" : "s"}` }));
  return out;
}

function guardView(t, held) {
  const { Box, Text, Button } = t;
  const decide = (choice) => () => { if (held.decision === null) held.decision = choice; };
  return Box({
    flexDirection: "column", borderStyle: "single", borderColor: C.warn, paddingX: 1,
    children: [
      Text({ key: "title", children: [
        Text({ key: "m", color: C.warn, children: "▲ guard" }),
        Text({ key: "s", color: C.line, children: " // " }),
        Text({ key: "f", color: C.fg, children: held.file }),
      ] }),
      ...held.touches.slice(0, 4).map((x, i) => Text({ key: `w${i}`, children: [
        Text({ key: "a", color: C.line, children: "  └ " }),
        Text({ key: "n", color: C.amb, children: x.name.toLowerCase() }),
        Text({ key: "b", color: C.mut, children: `'s agent edited it ${ago(x.at)}${x.task ? ` on ${x.task}` : ""}` }),
      ] })),
      ...(held.touches.length ? [Text({ key: "q", color: C.dim, children: "  editing now may overwrite their work" })] : []),
      ...(held.behind ?? []).slice(0, 2).map((p, i) => Text({ key: `u${i}`, children: [
        Text({ key: "a", color: C.line, children: "  └ " }),
        Text({ key: "n", color: C.amb, children: p.name.toLowerCase() }),
        Text({ key: "b", color: C.mut, children: ` pushed a newer version ${ago(p.at)} · ${p.sha.slice(0, 7)} · you are behind` }),
      ] })),
      ...(held.slices ?? []).slice(0, 2).map((x, i) => Text({ key: `s${i}`, children: [
        Text({ key: "a", color: C.line, children: "  └ " }),
        Text({ key: "b", color: C.mut, children: "in " }),
        Text({ key: "n", color: C.amb, children: `${x.name.toLowerCase()}'s slice` }),
        Text({ key: "c", color: C.dim, children: ` · ${x.slice} · #${x.roomName}` }),
      ] })),
      ...(held.breaks ?? []).slice(0, 3).map((b, i) => Box({ key: `d${i}`, flexDirection: "column", children: [
        Text({ key: "h", children: [
          Text({ key: "a", color: C.line, children: "  └ " }),
          Text({ key: "b", color: C.mut, children: "breaks " }),
          Text({ key: "c", color: C.amb, children: `D-${b.id}` }),
          Text({ key: "d", color: C.dim, children: ` · pinned by ${nameOf(b.author).toLowerCase()}${b.source === "pattern" ? " · pattern" : ""}` }),
        ] }),
        Text({ key: "t", color: C.fg, wrap: "truncate-end", children: `    "${b.text}"` }),
      ] })),
      Box({ key: "buttons", marginTop: 1, gap: 3, children: [
        ...((held.behind ?? []).length ? [Button({ key: "pull", label: "pull first", hotkey: "3", autoFocus: true, variant: "primary", onPress: decide("pull") })] : []),
        Button({ key: "cancel", label: held.touches.length || (held.slices ?? []).length ? "cancel and ask them" : "cancel and rework", hotkey: "2", autoFocus: !(held.behind ?? []).length, variant: (held.behind ?? []).length ? "secondary" : "primary", onPress: decide("cancel") }),
        Button({ key: "proceed", label: "proceed", hotkey: "1", plain: true, dimColor: true, onPress: decide("proceed") }),
      ] }),
    ],
  });
}

// ---- helpers ------------------------------------------------------------------

function nameOf(id) {
  return state.team?.people.find((p) => p.id === id)?.name ?? id;
}

function relPath(root, file) {
  const f = String(file ?? "");
  return root && f.startsWith(root + "/") ? f.slice(root.length + 1) : f;
}

function ago(ts) {
  const m = Math.round((Date.now() - ts) / 60000);
  return m < 1 ? "just now" : m < 60 ? `${m}m ago` : `${Math.round(m / 60)}h ago`;
}

function short(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n ?? 0);
}
