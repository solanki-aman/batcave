// Rooms are the unit of shared work. A room carries what someone needs to join
// in and start: the branch everyone shares (each person in their own working
// copy), who is in it and which slice each person owns, how to run and test,
// room rules, and the cards it covers. Agents of members get it as context.

const MAX_PUSHES = 30;

// "src/router/**" -> /^src\/router\/.*$/ ; "*.ts" matches in any directory
export function globToRe(glob) {
  const g = String(glob).trim().replace(/^\.\//, '');
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*' && g[i + 1] === '*') { re += '.*'; i++; if (g[i + 1] === '/') i++; }
    else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(g.includes('/') ? `^${re}$` : `(^|/)${re}$`);
}

export function inSlice(file, paths) {
  return (paths || []).some((p) => { try { return globToRe(p).test(file); } catch { return false; } });
}

export function setupRooms(x) {
  const { route, db, now, need, str, cleanId, slugify, person, broadcast, post, HttpError, activeTaskOf } = x;
  db.pushes ||= {};

  function norm(r) {
    if (!r) return r;
    r.name ||= r.id;
    r.tasks ||= r.task ? [r.task] : [];
    r.members ||= [];
    r.slices ||= {};
    r.run ||= {};
    r.rules ||= '';
    r.invites ||= {};
    if (r.branch === undefined) r.branch = null;
    return r;
  }
  for (const r of Object.values(db.rooms)) norm(r);

  const roomOf = (id) => norm(db.rooms[String(id || '').replace(/^#/, '')]);
  const isMember = (r, me) => Boolean(r && (r.members.includes(me) || r.id === 'team'));

  function addMember(r, id, by = null) {
    if (!db.people[id] || r.members.includes(id)) return false;
    r.members.push(id);
    if (by && by !== id) r.invites[id] = { by, at: now() };
    return true;
  }

  function publicRoom(r) {
    norm(r);
    const pushes = r.branch ? (db.pushes[r.branch] || []).slice(-8) : [];
    return { ...r, pushes };
  }

  function touch(r) { broadcast('room', publicRoom(r)); }

  // The room this person is working in: the one they joined last, else their active task's.
  function focusRoomOf(me) {
    const p = person(me);
    const joined = p?.room && roomOf(p.room);
    if (joined && isMember(joined, me) && joined.id !== 'team') return joined;
    const t = activeTaskOf(me);
    return t ? roomOf(t.room) : null;
  }

  // Called when a task is claimed or picked up: the task's room takes its branch and owner.
  function onClaim(t, me) {
    const r = roomOf(t.room);
    if (!r) return;
    if (!r.branch && t.branch) r.branch = t.branch;
    addMember(r, me);
    const p = person(me); if (p) p.room = r.id;
    touch(r);
  }

  function onPost(roomId, author) {
    const r = roomOf(roomId);
    if (r && r.id !== 'team' && addMember(r, author)) touch(r);
  }

  // A push to a shared branch: remember which files it carried, so teammates
  // who are behind get stopped before they edit those files.
  function recordPush(me, branch, sha) {
    if (!branch || !sha) return null;
    const list = (db.pushes[branch] ||= []);
    const last = [...list].reverse().find((p) => p.by === me);
    const since = last ? last.at : now() - 24 * 60 * 60 * 1000;
    const files = [...new Set(db.touches.filter((t) => t.person === me && t.at > since).map((t) => t.file))].slice(0, 200);
    const push = { sha: String(sha).slice(0, 40), by: me, at: now(), files };
    list.push(push);
    if (list.length > MAX_PUSHES) list.splice(0, list.length - MAX_PUSHES);
    for (const r of Object.values(db.rooms)) {
      if (r.branch !== branch) continue;
      post(r.id, me, `pushed ${files.length} file${files.length === 1 ? '' : 's'} to ${branch}`, 'event', { push: push.sha });
      touch(r);
    }
    return push;
  }

  const upstreamFor = (me, branch) => (branch ? (db.pushes[branch] || []).filter((p) => p.by !== me).slice(-10).reverse().map((p) => ({ ...p, name: person(p.by)?.name || p.by })) : []);

  // Files that sit in another member's slice of the rooms this person is in.
  function sliceConflicts(me, files) {
    const out = [];
    const rooms = Object.values(db.rooms).filter((r) => norm(r).members.includes(me));
    for (const r of rooms) {
      for (const [who, s] of Object.entries(r.slices)) {
        if (who === me) continue;
        for (const f of files) if (inSlice(f, s.paths)) out.push({ room: r.id, roomName: r.name, person: who, name: person(who)?.name || who, slice: s.name || s.paths.join(', '), file: f });
      }
    }
    return out;
  }

  // What an agent in this room is told, every session and prompt (deduped and ranked like the rest).
  function contextLines(me) {
    const r = focusRoomOf(me);
    if (!r) return [];
    const lines = [`Room #${r.name}${r.name !== r.id ? ` (${r.id})` : ''}${r.tasks.length ? `, cards ${r.tasks.join(', ')}` : ''}.`];
    if (r.branch) lines.push(`Shared branch: ${r.branch}. Each member works in their own checkout of it; pull before editing files a teammate pushed, push small and often.`);
    const mine = r.slices[me];
    const members = r.members.map((id) => {
      const s = r.slices[id];
      return `${person(id)?.name || id}${id === me ? ' (you)' : ''}${s ? `: ${s.name ? `${s.name}, ` : ''}${s.paths.join(' ')}` : ''}`;
    });
    lines.push(`Members: ${members.join('; ')}.`);
    if (mine) lines.push(`Your slice: ${mine.paths.join(' ')}. Stay inside it; ask in the room before changing another member's slice.`);
    const run = Object.entries(r.run).filter(([k, v]) => v && (k !== 'env' || v.length));
    if (run.length) lines.push(`Run and test: ${run.map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`).join(' · ')}. Use these, not your own variants.`);
    if (r.rules) lines.push(`Room rules:\n${r.rules}`);
    return lines;
  }

  // ---------- routes ----------

  route('POST', '/api/rooms', ({ me, body }) => {
    const name = str(body.name, 'name', 80);
    let id = slugify(name, 40) || `room-${Date.now()}`;
    while (db.rooms[id]) id = `${id}-${Math.random().toString(36).slice(2, 5)}`;
    const r = norm({ id, name, task: null, createdAt: now(), createdBy: me });
    db.rooms[id] = r;
    addMember(r, me);
    for (const h of Array.isArray(body.members) ? body.members : []) addMember(r, cleanId(h), me);
    if (typeof body.branch === 'string' && body.branch.trim()) r.branch = body.branch.trim().slice(0, 200);
    for (const t of Array.isArray(body.tasks) ? body.tasks : []) if (db.tasks[t] && !r.tasks.includes(t)) r.tasks.push(t);
    post(id, me, `created #${name}`, 'event');
    touch(r);
    return publicRoom(r);
  });

  route('GET', '/api/rooms/:id', ({ params }) => {
    const r = roomOf(params.id);
    need(r, 404, `no room ${params.id}`);
    return publicRoom(r);
  });

  route('POST', '/api/rooms/:id/rename', ({ me, params, body }) => {
    const r = roomOf(params.id);
    need(r, 404, `no room ${params.id}`);
    const before = r.name;
    r.name = str(body.name, 'name', 80).replace(/^#/, '');
    post(r.id, me, `renamed #${before} to #${r.name}`, 'event');
    touch(r);
    return publicRoom(r);
  });

  route('POST', '/api/rooms/:id/invite', ({ me, params, body }) => {
    const r = roomOf(params.id);
    need(r, 404, `no room ${params.id}`);
    const handles = (Array.isArray(body.members) ? body.members : String(body.members || '').split(/[\s,]+/)).map((h) => cleanId(String(h).replace(/^@/, ''))).filter(Boolean);
    const unknown = handles.filter((h) => !db.people[h]);
    need(!unknown.length, 404, `no teammate called ${unknown.join(', ')}`);
    const added = handles.filter((h) => addMember(r, h, me));
    if (added.length) post(r.id, me, `added ${added.map((h) => person(h)?.name || h).join(', ')}`, 'event');
    touch(r);
    return { ...publicRoom(r), added };
  });

  route('POST', '/api/rooms/:id/join', ({ me, params, body }) => {
    const r = roomOf(params.id);
    need(r, 404, `no room ${params.id}`);
    const fresh = addMember(r, me);
    if (body.slice) setSlice(r, me, body.slice, body.sliceName);
    const p = person(me); if (p) p.room = r.id;
    if (fresh) post(r.id, me, `joined${r.slices[me] ? `, taking ${r.slices[me].name || r.slices[me].paths.join(' ')}` : ''}`, 'event');
    touch(r);
    return publicRoom(r);
  });

  route('POST', '/api/rooms/:id/leave', ({ me, params }) => {
    const r = roomOf(params.id);
    need(r, 404, `no room ${params.id}`);
    r.members = r.members.filter((x) => x !== me);
    delete r.slices[me];
    const p = person(me); if (p?.room === r.id) p.room = null;
    post(r.id, me, 'left', 'event');
    touch(r);
    return { ok: true };
  });

  function setSlice(r, who, paths, name) {
    const list = (Array.isArray(paths) ? paths : String(paths).split(/[\s,]+/)).map((s) => s.trim()).filter(Boolean).slice(0, 20);
    if (!list.length) { delete r.slices[who]; return; }
    for (const p of list) { try { globToRe(p); } catch { throw new HttpError(400, `bad path pattern ${p}`); } }
    r.slices[who] = { paths: list, name: typeof name === 'string' ? name.slice(0, 60) : '' , at: now() };
  }

  route('POST', '/api/rooms/:id/slice', ({ me, params, body }) => {
    const r = roomOf(params.id);
    need(r, 404, `no room ${params.id}`);
    need(isMember(r, me), 403, `join #${r.name} first`);
    setSlice(r, me, body.paths ?? '', body.name);
    const s = r.slices[me];
    post(r.id, me, s ? `took the slice ${s.name ? `${s.name} (${s.paths.join(' ')})` : s.paths.join(' ')}` : 'dropped their slice', 'event');
    touch(r);
    return publicRoom(r);
  });

  // Branch, run and test commands, rules and cards: any member can set them.
  route('POST', '/api/rooms/:id/set', ({ me, params, body }) => {
    const r = roomOf(params.id);
    need(r, 404, `no room ${params.id}`);
    need(isMember(r, me), 403, `join #${r.name} first`);
    const changed = [];
    if (typeof body.branch === 'string') { r.branch = body.branch.trim().slice(0, 200) || null; changed.push('branch'); }
    for (const k of ['setup', 'dev', 'test', 'preview', 'lint']) {
      if (typeof body[k] === 'string') { r.run[k] = body[k].slice(0, 300); changed.push(k); }
    }
    if (body.env !== undefined) {
      r.run.env = (Array.isArray(body.env) ? body.env : String(body.env).split(/[\s,]+/)).map((s) => s.trim()).filter((s) => /^[A-Z_][A-Z0-9_]*$/i.test(s)).slice(0, 40);
      changed.push('env');
    }
    if (typeof body.rules === 'string') { r.rules = body.rules.slice(0, 3000); changed.push('rules'); }
    if (typeof body.addTask === 'string' && db.tasks[body.addTask] && !r.tasks.includes(body.addTask)) { r.tasks.push(body.addTask); changed.push(`card ${body.addTask}`); }
    need(changed.length, 400, 'nothing to set: pass branch, setup, dev, test, preview, lint, env, rules or addTask');
    post(r.id, me, `set ${changed.join(', ')}`, 'event');
    touch(r);
    return publicRoom(r);
  });

  return { roomOf, focusRoomOf, publicRoom, onClaim, onPost, recordPush, upstreamFor, sliceConflicts, contextLines, isMember };
}
