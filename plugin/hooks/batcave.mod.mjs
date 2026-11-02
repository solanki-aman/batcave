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
const TABS = ["Board", "Team", "Requests", "Stats"];
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
  seen: { requests: new Set(), handoffs: new Set(), decisions: new Set() },
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

  on("turn.complete", async ($, e, next) => {
    const result = await next(e);
    if (!e.agentId) await refresh($);
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
    const hint = String(e.new_string ?? e.content ?? e.new_source ?? "").slice(0, 200);
    try {
      const g = await api($, "GET", `/api/guard?files=${encodeURIComponent(file)}${hint ? `&change=${encodeURIComponent(hint)}` : ""}`);
      touches = g && g.conflict ? g.touches : [];
      verdict = g;
    } catch {
      return next(e); // fail open: a missing server never blocks an edit
    }
    if (touches.length === 0) {
      return next(e);
    }
    if (verdict.severity === "low") {
      // Alfred judged the overlap trivial: mention it, do not stop the edit
      $.ui.toast(`Batcave · ${touches[0].name} also touched ${file}; overlap looks trivial, going ahead`);
      return next(e);
    }
    while (state.held !== null) {
      if (next.signal.aborted) return { deny: "Batcave held this edit: the turn was interrupted. Do not retry unless the user asks." };
      await $.process.run(["sleep", POLL_SECONDS], { timeoutMs: 5000 });
    }
    const mine = { file, touches, decision: null, where: "pane" };
    state.held = mine;
    let opened = { isPlaced: false };
    try {
      opened = await $.ui.open({ id: GUARD_ID, title: "Batcave guard", focus: true, rows: 9 + Math.min(4, touches.length) });
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
    if (verdict.decisionId && (mine.decision === "proceed" || mine.decision === "cancel")) {
      try { await api($, "POST", "/api/feedback", { id: verdict.decisionId, outcome: mine.decision === "proceed" ? "proceeded-real" : "cancelled-real" }); } catch { /* best effort */ }
    }
    if (mine.decision === "proceed") {
      return next(e);
    }
    const who = touches.map((t) => `${t.name}'s agent (${t.task ?? "no task"})`).join(", ");
    const why = { cancel: "the user chose Cancel", timeout: "no answer within 10 minutes", interrupted: "the turn was interrupted" }[mine.decision] ?? "no answer";
    return { deny: `Batcave guard held this edit to ${file}: ${who} edited it recently, and ${why}. Coordinate with them first (batcave_say in their task room, or batcave_request). Do not retry unless the user asks.` };
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
    await $.process.run(["sh", "-c", 'd="${BATCAVE_HOME:-$HOME/.batcave}"; mkdir -p "$d" && date +%s > "$d/mod-active"'], { timeoutMs: 3000 });
  } catch (err) {
    state.error = String(err?.message ?? err).slice(0, 80);
  }
  $.ui.invalidate("ui.render");
}

// Toast what is new for this user since the last poll. The first poll only primes.
async function announce($, team) {
  const me = state.cfg.user;
  const fresh = [];
  for (const r of team.requests.filter((x) => x.to === me)) {
    if (!state.seen.requests.has(r.id)) { state.seen.requests.add(r.id); fresh.push({ kind: "request", text: `${nameOf(r.from)} asked your agent: ${r.text}`, room: r.room }); }
  }
  for (const h of team.handoffs.filter((x) => x.to === me)) {
    if (!state.seen.handoffs.has(h.id)) { state.seen.handoffs.add(h.id); fresh.push({ kind: "handoff", text: `${nameOf(h.from)} handed you ${h.task}`, room: "" }); }
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
      await $.prompt.submit({ text: `Teammate request R-${req.id} from ${nameOf(req.from)}, which I accepted in Batcave: ${req.text}` });
    } else {
      $.ui.toast(`Batcave · declined R-${req.id}`);
    }
  } catch (err) {
    $.ui.toast(`Batcave · ${String(err?.message ?? err).slice(0, 120)}`);
  }
  await refresh($);
}

// ---- drawing ----------------------------------------------------------------

function band($, t, columns) {
  const { Box, Text, Button } = t;
  if (state.error) {
    return Box({ flexDirection: "row", paddingX: 1, children: [Text({ color: "red", children: "○ batcave offline" }), Text({ dimColor: true, children: `  ${state.error}` })] });
  }
  const team = state.team;
  if (!team) return Text({ dimColor: true, children: " ◆ batcave connecting..." });
  const me = state.cfg.user;
  const online = team.people.filter((p) => p.presence !== "offline" && p.presence !== "away").length;
  const reqs = team.requests.filter((r) => r.to === me).length;
  const mine = team.tasks.find((x) => x.owner === me && (x.status === "claimed" || x.status === "running"));
  const busy = team.people.filter((p) => p.id !== me && p.presence === "agent running").slice(0, columns >= 140 ? 2 : 1);
  const saved = state.stats?.tokens?.saved ?? 0;
  const parts = [
    Text({ key: "dot", color: "green", children: "◆ " }),
    Text({ key: "team", bold: true, children: team.team }),
    Text({ key: "on", dimColor: true, children: ` · ${online} online` }),
  ];
  if (reqs) parts.push(Text({ key: "req", color: "yellow", bold: true, children: ` · ${reqs} request${reqs > 1 ? "s" : ""}` }));
  const suggestion = mine ? null : team.people.find((p) => p.id === me)?.suggestion;
  if (suggestion) parts.push(Text({ key: "mine", color: "cyan", children: ` · looks like ${suggestion.task}: ${suggestion.title}`, wrap: "truncate-end" }));
  else parts.push(Text({ key: "mine", children: mine ? ` · ${mine.id} ${mine.status}` : " · no claim" }));
  if (columns >= 100) for (const p of busy) parts.push(Text({ key: `b-${p.id}`, color: "cyan", children: ` · ${p.name}: ${p.now || "working"}`, wrap: "truncate-end" }));
  if (columns >= 120 && saved) parts.push(Text({ key: "saved", dimColor: true, children: ` · ${short(saved)} tok saved` }));
  const buttons = columns >= 90 ? [
    ...(suggestion ? [Button({ key: "suggest", label: `Claim ${suggestion.task}`, hotkey: "c", onPress: () => claim($, suggestion.task) })] : []),
    Button({ key: "board", label: "Board", hotkey: "b", onPress: () => openPane($, 0) }),
    Button({ key: "team", label: "Team", hotkey: "t", onPress: () => openPane($, 1) }),
    ...(reqs ? [Button({ key: "requests", label: "Requests", hotkey: "q", onPress: () => openPane($, 2) })] : []),
  ] : [];
  return Box({ flexDirection: "row", paddingX: 1, gap: 2, children: [Box({ key: "line", flexDirection: "row", flexShrink: 1, children: parts }), ...buttons] });
}

function paneView($, t, e, inBand) {
  const { Box, Text, Button } = t;
  const tabs = TABS.map((name, i) => Button({
    key: `tab-${i}`, label: name, hotkey: String(i + 1), plain: i !== state.tab, autoFocus: i === state.tab,
    onPress: () => { state.tab = i; $.ui.invalidate("ui.render"); },
  }));
  const close = () => {
    state.paneOpen = false;
    if (!state.paneInBand) $.ui.close({ id: PANE_ID });
    state.paneInBand = false;
    $.ui.invalidate("ui.render");
  };
  let body;
  if (!state.team) body = [Text({ key: "x", dimColor: true, children: state.error || "Loading..." })];
  else if (state.tab === 0) body = boardTab($, t, inBand ? Math.max(4, (e.maxRows || 16) - 6) : 14);
  else if (state.tab === 1) body = teamTab(t);
  else if (state.tab === 2) body = requestsTab($, t);
  else body = statsTab(t);
  return Box({
    flexDirection: "column", borderStyle: "round", borderColor: "cyan", paddingX: 1,
    children: [
      Box({ key: "head", flexDirection: "row", justifyContent: "space-between", children: [
        Text({ bold: true, color: "cyan", children: `◆ Batcave · ${state.team?.team ?? ""}` }),
        Button({ key: "close", label: "Close", hotkey: "x", plain: true, onPress: close }),
      ] }),
      Box({ key: "tabs", flexDirection: "row", gap: 1, children: tabs }),
      Box({ key: "body", flexDirection: "column", marginTop: 1, children: body }),
    ],
  });
}

function boardTab($, t, rows) {
  const { Box, Text, Button } = t;
  const out = [];
  let hot = 0;
  for (const [status, label] of LANES) {
    const list = state.team.tasks.filter((x) => x.status === status).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, status === "done" ? 2 : 4);
    out.push(Text({ key: `h-${status}`, bold: true, color: "cyan", children: `${label.toUpperCase()} ${state.team.tasks.filter((x) => x.status === status).length}` }));
    for (const task of list) {
      const who = task.owner ? ` · ${nameOf(task.owner)}` : "";
      const stale = task.stale ? " · stale" : "";
      const row = [Text({ key: "t", wrap: "truncate-end", children: `  ${task.id}  ${task.title}${who}${stale}` })];
      if ((status === "backlog" || task.stale) && hot < 9) {
        hot += 1;
        row.push(Button({ key: "c", label: task.stale ? "Take over" : "Claim", hotkey: String.fromCharCode(96 + hot), plain: true, onPress: () => claim($, task.id) }));
      }
      out.push(Box({ key: `r-${task.id}`, flexDirection: "row", justifyContent: "space-between", children: row }));
    }
  }
  return out.slice(0, rows + 5);
}

function teamTab(t) {
  const { Box, Text } = t;
  const order = { "agent running": 0, online: 1, away: 2, offline: 3 };
  const color = { "agent running": "cyan", online: "green", away: "yellow", offline: undefined };
  return [...state.team.people].sort((a, b) => order[a.presence] - order[b.presence]).map((p) => Box({
    key: p.id, flexDirection: "column", marginBottom: 1, children: [
      Box({ flexDirection: "row", gap: 1, children: [
        Text({ bold: true, children: `${p.name}${p.id === state.cfg.user ? " (you)" : ""}` }),
        Text({ color: color[p.presence], dimColor: p.presence === "offline", children: p.presence }),
        p.tool ? Text({ dimColor: true, children: `· ${p.tool}` }) : null,
      ] }),
      Text({ dimColor: true, wrap: "truncate-end", children: `  now: ${p.now || "idle"}${p.task ? ` · ${p.task}` : ""}` }),
      Text({ dimColor: true, children: `  week: ${p.stats.shipped} shipped · ${p.stats.prsOpen} PR open · ${p.stats.reviewsOwed} reviews owed` }),
    ],
  }));
}

function requestsTab($, t) {
  const { Box, Text, Button } = t;
  const mine = state.team.requests.filter((r) => r.to === state.cfg.user);
  if (!mine.length) return [Text({ key: "none", dimColor: true, children: "No requests for your agent." })];
  return mine.slice(0, 5).map((r, i) => Box({
    key: `q-${r.id}`, flexDirection: "column", marginBottom: 1, children: [
      Text({ wrap: "wrap", children: [Text({ bold: true, children: `R-${r.id} from ${nameOf(r.from)}: ` }), Text({ children: r.text })] }),
      Box({ flexDirection: "row", gap: 2, children: [
        Button({ key: "run", label: "Run on my agent", hotkey: String.fromCharCode(97 + i * 2), onPress: () => answer($, r, "accept") }),
        Button({ key: "decline", label: "Decline", hotkey: String.fromCharCode(98 + i * 2), plain: true, onPress: () => answer($, r, "decline") }),
      ] }),
    ],
  }));
}

function statsTab(t) {
  const { Text } = t;
  const s = state.stats;
  if (!s) return [Text({ key: "none", dimColor: true, children: "No stats from the server." })];
  const k = s.tokens;
  const lat = Object.entries(s.latency).filter(([key]) => /^(hook:|alfred:)/.test(key)).slice(0, 6);
  const max = Math.max(1, ...lat.map(([, v]) => v.p95 || 0));
  return [
    Text({ key: "saved", children: [Text({ color: "green", bold: true, children: `${short(k.saved)} tokens saved` }), Text({ dimColor: true, children: `  (${k.savedPct}% of what agents would have received)` })] }),
    Text({ key: "split", dimColor: true, children: `dedupe ${short(k.savedDedupe)} · Alfred ranking ${short(k.savedRanking)} · injected ${short(k.injected)}` }),
    Text({ key: "alfred", dimColor: true, children: `Alfred: ${s.alfred?.ready ? `ready, ${s.alfred.model} on ${s.alfred.device}` : "not running"}` }),
    Text({ key: "lh", bold: true, color: "cyan", children: "LATENCY p50 / p95" }),
    ...lat.map(([key, v]) => Text({ key, wrap: "truncate-end", children: `${key.padEnd(18)} ${String(v.p50 ?? "-").padStart(6)} / ${String(v.p95 ?? "-").padEnd(6)} ${"█".repeat(Math.max(1, Math.round(((v.p95 || 0) / max) * 16)))}` })),
  ];
}

function guardView(t, held) {
  const { Box, Text, Button } = t;
  const decide = (choice) => () => { if (held.decision === null) held.decision = choice; };
  return Box({
    flexDirection: "column", borderStyle: "round", borderColor: "yellow", paddingX: 1,
    children: [
      Text({ key: "title", bold: true, color: "yellow", children: `◆ Batcave guard · ${held.file}` }),
      ...held.touches.slice(0, 4).map((x, i) => Text({ key: `w${i}`, children: `  ${x.name}'s agent edited it ${ago(x.at)}${x.task ? ` on ${x.task}` : ""}` })),
      Text({ key: "q", dimColor: true, children: "Editing now may overwrite their work or cause a conflict." }),
      Box({ key: "buttons", marginTop: 1, gap: 2, children: [
        Button({ key: "proceed", label: "Proceed", hotkey: "1", plain: true, onPress: decide("proceed") }),
        Button({ key: "cancel", label: "Cancel and ask them", hotkey: "2", autoFocus: true, onPress: decide("cancel") }),
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
