<p align="center">
  <img src="docs/assets/hero.svg" alt="Batcave: multiplayer Claude Code" width="100%">
</p>

<p align="center">
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-141413?style=flat-square"></a>
  <img alt="Node 18+" src="https://img.shields.io/badge/node-18%2B-141413?style=flat-square">
  <img alt="Zero dependencies" src="https://img.shields.io/badge/dependencies-0-D97757?style=flat-square">
  <img alt="Claude Code plugin" src="https://img.shields.io/badge/Claude%20Code-plugin-D97757?style=flat-square">
</p>

<p align="center">
  <b>A shared board, live presence, rooms, pinned decisions, requests between teammates' Claudes, handoffs and an edit guard.</b><br>
  For teams where everyone runs their own Claude Code.
</p>

<p align="center">
  <a href="#quick-start">Quick start</a> ·
  <a href="#a-day-in-batcave">A day in Batcave</a> ·
  <a href="#features">Features</a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="#api-reference">API</a> ·
  <a href="#roadmap">Roadmap</a>
</p>

---

## See it

**In your terminal.** Claim a task, get stopped before you overwrite a teammate's work, and run a request a teammate sent to your Claude.

<p align="center"><img src="docs/assets/terminal.gif" alt="Claude Code session using Batcave: board, claim, guard and request" width="88%"></p>

**On the dashboard.** The same state, live, for everyone who does not live in a terminal. Cards move on their own as agents start work and open PRs.

<p align="center"><img src="docs/assets/dashboard.gif" alt="Batcave web dashboard updating live: board, people, rooms and decisions" width="100%"></p>

**In your status line.** The team, always one glance away.

<p align="center"><img src="docs/assets/statusline.svg" alt="Status line: acme-web, 4 online, 1 request, 1 review owed, T-9 running" width="75%"></p>

---

## Why

Coding agents made each developer faster and the team slower to align. More agents mean more code, more PRs and more merge conflicts, while the team's shared context sits in private terminals.

So teams are back to asking the basic questions all day:

> *Who is working on what? What did we decide? Whose agent is touching this file? Where did my teammate leave off?*

Batcave answers them inside the tool everyone already uses, without changing how anyone works.

### The one rule: everyone runs their own Claude

Batcave never holds anyone's Claude credentials, never proxies model calls, and never runs one person's Claude on another person's behalf.

When Nate wants Aman's Claude to do something, he sends a **request**. It waits in Aman's inbox and runs only if Aman chooses to run it, in his own session, as his own prompt. Every person's usage stays on their own account, and every person stays in charge of their own agent.

---

## Quick start

### 1. Start a server (one person, once per team)

Node 18 or newer. No `npm install`; the server has zero dependencies.

```bash
git clone https://github.com/solanki-aman/batcave.git && cd batcave
export BATCAVE_TEAM=acme
export BATCAVE_TEAM_TOKEN=$(node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))")
echo "Share privately: $BATCAVE_TEAM_TOKEN"
node server/src/index.mjs
```

```text
[batcave] team "acme" listening on http://0.0.0.0:4777 (token required)
```

For a real team, run it with Docker behind HTTPS. See [Deploying the server](#deploying-the-server).

### 2. Install the plugin (every teammate)

```text
/plugin marketplace add solanki-aman/batcave
/plugin install batcave@batcave
```

Restart Claude Code, then:

```text
/batcave:setup
```

The setup skill asks for the server URL, the team token, your handle and your name. It writes `~/.batcave/config.json`, offers to install the status line, and finishes with a health check:

```text
✓ Node 22.23.4
✓ Config file ~/.batcave/config.json
✓ Server up: team "acme" v0.1.0
✓ Authenticated. Active task: none
✓ Status line installed

All good.
```

### 3. Play

```text
/batcave:task Empty cart state
/batcave:board
/batcave:claim T-1
/batcave:decide Reuse surface tokens. No new colors.
/batcave:people
```

Or just talk to Claude: *"what is Nate working on?"*, *"claim the empty cart task"*, *"hand this to Priya"*.

---

## A day in Batcave

Five moments, end to end. Each diagram is exactly what the plugin and server do.

### 9:02 &nbsp; Aman opens Claude Code and already knows the score

The `SessionStart` hook signs him in and hands Claude the team's context before he types anything.

```mermaid
sequenceDiagram
    autonumber
    actor Aman
    participant CC as Aman's Claude Code
    participant Hook as Batcave hooks
    participant S as Batcave server

    Aman->>CC: opens a session in acme-web
    CC->>Hook: SessionStart
    Hook->>S: POST /api/presence (online)
    Hook->>S: GET /api/context
    S-->>Hook: active task, decisions, room messages, requests, handoffs
    Hook-->>CC: additionalContext
    Note over CC: Claude now knows: T-3 is in progress,<br/>"no new colors" is decided,<br/>Nate asked for a screenshot
    CC-->>Aman: ready, with the team in mind
```

### 9:15 &nbsp; Aman claims the next task

One command assigns the card, names a branch, opens a room and loads the task's context.

```mermaid
sequenceDiagram
    autonumber
    actor Aman
    participant C as Aman's Claude
    participant MCP as Batcave MCP tools
    participant S as Batcave server
    participant Git as git

    Aman->>C: /batcave:claim T-9
    C->>MCP: batcave_claim(T-9)
    MCP->>S: POST /api/tasks/T-9/claim
    alt someone else holds a fresh claim
        S-->>MCP: 409 claimed by Nate
        MCP-->>C: suggest asking Nate for a handoff
    else free or stale
        S-->>MCP: task, branch, room, context, other active claims
        S-)S: broadcast to dashboard and status lines
        MCP-->>C: claimed + context
        C->>Git: git switch -c aman/t-9-dark-mode-for-receipt
        C-->>Aman: task, branch, decisions that apply
    end
```

### 10:40 &nbsp; The guard stops a collision before it happens

Aman's Claude goes to edit `tokens.ts`. Nate's Claude edited it four minutes ago.

```mermaid
sequenceDiagram
    autonumber
    participant N as Nate's Claude
    participant S as Batcave server
    participant A as Aman's Claude
    participant H as PreToolUse hook
    actor Aman

    N->>S: PostToolUse: edit src/theme/tokens.ts
    Note over S: touch recorded (Nate, T-4, 10:36)
    A->>H: about to Edit src/theme/tokens.ts
    H->>S: GET /api/guard?files=src/theme/tokens.ts
    S-->>H: conflict: Nate's Claude, 4m ago, T-4
    H-->>A: permissionDecision: ask
    A-->>Aman: "Nate's Claude edited it 4m ago. Allow this edit?"
    Aman->>A: no
    A->>S: batcave_say to the T-4 room: "Can the email token land with T-4?"
```

### 11:05 &nbsp; Nate asks Aman's Claude for a favor

Requests are how one teammate gets help from another's agent without anyone borrowing a subscription.

```mermaid
sequenceDiagram
    autonumber
    actor Nate
    participant S as Batcave server
    participant AC as Aman's Claude
    actor Aman

    Nate->>S: "@aman-claude add a screenshot to the PR"
    S->>S: create request R-1 (pending)
    S-)AC: next prompt: "1 pending request. Do not act unless the user chooses."
    Note over Aman: status line shows "1 request"
    Aman->>AC: /batcave:requests
    AC-->>Aman: R-1 from Nate. Run, edit first, or decline?
    Aman->>AC: run it
    AC->>S: resolve R-1 accept
    AC->>AC: does the work as Aman's own prompt
    S-)Nate: room: "Aman accepted request from Nate"
```

### 5:30 &nbsp; Aman hands off and logs off

Handoffs move the card and carry everything the next person needs.

```mermaid
sequenceDiagram
    autonumber
    actor Aman
    participant AC as Aman's Claude
    participant S as Batcave server
    participant PC as Priya's Claude
    actor Priya

    Aman->>AC: /batcave:handoff priya
    AC->>AC: commit, git push, draft summary and todos
    AC-->>Aman: review summary
    Aman->>AC: looks good
    AC->>S: POST /api/handoffs (T-9 to Priya)
    S-)PC: next session: "Handoff H-1 waiting from Aman"
    Priya->>PC: /batcave:pickup 1
    PC->>S: POST /api/handoffs/1/pickup
    S-->>PC: branch, summary, todos, decisions, room history
    PC->>PC: git fetch, check out branch, read files
    PC-->>Priya: briefing and first todo
```

---

## Features

| | Feature | What it does |
|---|---|---|
| **Board** | Kanban with claims | Backlog, Claimed, Agent running, In review, Done. Cards move themselves as hooks see agents start, open PRs and merge. |
| **Claims** | `/batcave:claim T-14` | Assigns the task, names the branch, opens its room, loads its context. One active claim by default; stale claims can be taken over. |
| **People** | Presence and stats | Who is online, whose agent is running, what it is doing right now, and this week's shipped, PRs open, reviews owed, asks pending. |
| **Rooms** | One per task, plus `#team` | Agents post commits and status changes; people talk. |
| **Decisions** | Pinned once, followed everywhere | Every teammate's Claude sees pinned decisions in its context. |
| **Requests** | Ask a teammate's Claude | Lands in their inbox. They choose run, edit first, or decline. |
| **Guard** | Collision warning | Asks before Claude edits a file another teammate's agent touched recently. |
| **Handoff** | Pass the baton | Branch, summary, todos and decisions in one packet. `/batcave:pickup` starts with full context. |
| **Pulse** | Catch up | What shipped, what waits on you, what is running, stale claims, new decisions. |
| **Dashboard** | For the whole team | Board, People, Rooms and Decisions in the browser for PMs and designers. |
| **Status line** | Always on | `● acme · 4 online · 1 request · T-9 running` |

### The task lifecycle

<p align="center"><img src="docs/assets/lifecycle.svg" alt="Task lifecycle: backlog, claimed, agent running, in review, done" width="100%"></p>

A claim with no agent activity for 24 hours (configurable) is marked **stale**. Anyone can take it over, and the room records who took it from whom.

### Slash commands

| Command | Use it to |
|---|---|
| `/batcave:board [mine]` | See the board. |
| `/batcave:task <title>` | Add a task to the backlog. |
| `/batcave:claim <id>` | Claim a task, create its branch, load its context. |
| `/batcave:people` | See teammates, their agents' live state and weekly stats. |
| `/batcave:room [room]` | Read your task's room, or any room. |
| `/batcave:say <msg> \| summary` | Post to the room, or let Claude draft a summary of its work for you to approve. |
| `/batcave:decide <decision>` | Pin a decision for every teammate's Claude. No arguments lists them. |
| `/batcave:ask <handle> <ask>` | Send a request to a teammate's Claude. |
| `/batcave:requests` | Review asks for your Claude: run, edit first, or decline. |
| `/batcave:handoff <handle> [id]` | Hand off a task with a summary and todos. |
| `/batcave:pickup <id>` | Pick up a handoff and get briefed. |
| `/batcave:pulse [hours]` | Catch up on the team. |
| `/batcave:setup` | Set up or repair Batcave on this machine. |

### What happens automatically

| Moment | Hook | Effect |
|---|---|---|
| Session starts | `SessionStart` | You show as online. Claude gets your task, decisions, room messages, requests and handoffs. |
| You send a prompt | `UserPromptSubmit` | Your agent shows as running. Claude gets the team context again only if it changed. |
| Claude is about to edit | `PreToolUse` | The guard checks for recent edits by other teammates' agents. |
| Claude edits or runs a command | `PostToolUse` | Your "now" line updates. `git commit` posts to your room. `gh pr create` moves your card to In review. |
| Claude finishes a turn | `Stop` | Your agent shows as idle. |
| Session ends | `SessionEnd` | You show as offline. |

Every hook fails open with a 2.5 second timeout. If the server is slow or down, Claude Code keeps working and the status line says `○ batcave offline`.

---

## How it works

<p align="center"><img src="docs/assets/architecture.svg" alt="Architecture: teammates' machines exchange state with one Batcave server, which also feeds a web dashboard" width="100%"></p>

Batcave has two parts.

**The server** (`server/`) holds the team's shared state: people, tasks, rooms, messages, decisions, requests, handoffs and recent file edits. It exposes a JSON API, a server-sent event stream and the web dashboard. One per team.

**The Claude Code plugin** (`plugin/`) is installed by each teammate:

- **Hooks** report presence and activity, and inject the team's context into Claude's prompt.
- **An MCP server** gives Claude 18 tools to read and change the shared state.
- **Slash commands** give people one-word shortcuts.
- **A status line** shows the team at a glance.
- **A setup skill** walks anyone through installation.

### Design choices

- **Zero dependencies everywhere.** Node 18 built-ins only. The plugin works right after install, and the server is one `node` command.
- **State lives on the server, work lives on laptops.** The server never sees code: only file paths, branch names, commit subjects and the messages people choose to post.
- **Context is pushed, not pulled.** Decisions and room messages reach Claude through hooks, so nobody has to remember to ask. Injection is deduplicated per session to save tokens.
- **Fail open.** A missing server never blocks anyone's work.

### Repository layout

```
batcave/
├── .claude-plugin/marketplace.json   # lets /plugin marketplace add find the plugin
├── .claude/skills/batcave-setup      # symlink so the setup skill works inside this repo
├── plugin/                           # the Claude Code plugin
│   ├── .claude-plugin/plugin.json
│   ├── .mcp.json                     # registers the MCP server
│   ├── hooks/hooks.json              # hook wiring
│   ├── hooks/batcave-hook.mjs        # one script, one mode per hook event
│   ├── mcp/server.mjs                # zero-dependency MCP server over stdio
│   ├── commands/*.md                 # slash commands
│   ├── skills/batcave-setup/SKILL.md # guided setup
│   ├── scripts/setup.mjs             # write config, verify, install status line
│   ├── scripts/doctor.mjs            # health check
│   ├── scripts/statusline.mjs        # status line, cached 10 s
│   └── lib/client.mjs                # config and HTTP client shared by all of the above
├── server/
│   ├── src/index.mjs                 # HTTP API, SSE, domain logic
│   ├── src/store.mjs                 # JSON persistence
│   ├── public/index.html             # dashboard
│   └── Dockerfile
└── docs/assets/                      # the images in this README
```

---

## Configuration

### Per person: `~/.batcave/config.json`

Written by `setup.mjs` with mode 600. Never commit it.

```json
{
  "url": "https://batcave.example.com",
  "token": "team token",
  "user": "aman",
  "name": "Aman"
}
```

Environment variables override the file: `BATCAVE_URL`, `BATCAVE_TOKEN`, `BATCAVE_USER`, `BATCAVE_NAME`, `BATCAVE_HOME` (config folder) and `BATCAVE_DEBUG=1` (print hook errors).

### Per repo: `.batcave.json` (optional, committed)

```json
{
  "url": "https://batcave.example.com",
  "guardMinutes": 60,
  "shareActivity": true
}
```

Set `shareActivity` to `false` for repos where edits and commands should not be posted. Presence, claims and context still work.

### Server environment

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `4777` | Port to listen on. |
| `HOST` | `0.0.0.0` | Interface to bind. |
| `BATCAVE_TEAM` | `batcave` | Team name shown everywhere. |
| `BATCAVE_TEAM_TOKEN` | none | Shared secret. **Set it.** Without it the server accepts anyone. |
| `BATCAVE_DATA` | `./data/batcave.json` | Where state is persisted. |
| `BATCAVE_STALE_HOURS` | `24` | Hours without activity before a claim is stale. |
| `BATCAVE_GUARD_MINUTES` | `60` | Default guard window. |

---

## API reference

All `/api/*` routes except `/api/health` need `Authorization: Bearer <team token>` and `X-Batcave-User: <handle>` (optionally `X-Batcave-Name`). Responses are JSON.

<details>
<summary><b>Show all routes</b></summary>

| Method | Route | Body / query | Purpose |
|---|---|---|---|
| GET | `/api/health` | | Liveness, team name, whether auth is on. |
| GET | `/api/state` | | Everything the dashboard needs. |
| GET | `/api/stream` | `?token=` | Server-sent events: `task`, `person`, `message`, `decision`, `request`, `handoff`. |
| POST | `/api/presence` | `status`, `agent`, `now`, `role`, `branch` | Update your presence. |
| GET | `/api/people` | | Teammates with presence and stats. |
| GET | `/api/tasks` | `?status=&owner=` | List tasks. |
| POST | `/api/tasks` | `title`, `description`, `source` | Create a backlog task. |
| GET | `/api/tasks/:id` | | One task. |
| POST | `/api/tasks/:id/claim` | `branch`, `force` | Claim. 409 if someone else holds a fresh claim. |
| POST | `/api/tasks/:id/release` | | Back to backlog. |
| POST | `/api/tasks/:id/status` | `status`, `pr`, `reviewer` | Move a card. |
| GET | `/api/rooms` | | Rooms. |
| GET | `/api/rooms/:id/messages` | `?limit=` | Recent messages. |
| POST | `/api/rooms/:id/messages` | `text`, `kind` | Post. `@handle-claude` creates a request. |
| GET | `/api/decisions` | `?room=` | Active decisions. |
| POST | `/api/decisions` | `text`, `room` | Pin a decision. |
| POST | `/api/decisions/:id/retire` | | Retire a decision. |
| GET | `/api/requests` | `?box=inbox\|sent&status=` | Your requests. |
| POST | `/api/requests` | `to`, `text`, `room` | Ask a teammate's Claude. |
| POST | `/api/requests/:id/resolve` | `action: accept\|decline` | Recipient only. |
| POST | `/api/handoffs` | `task`, `to`, `summary`, `todos` | Owner only. Transfers the card. |
| GET | `/api/handoffs` | | Open handoffs to or from you. |
| POST | `/api/handoffs/:id/pickup` | | Recipient only. Returns the packet. |
| POST | `/api/events` | `type`, `files`, `command`, `summary`, `url` | Activity from hooks: `turn_start`, `turn_end`, `edit`, `command`, `commit`, `pr`. |
| GET | `/api/guard` | `?files=a,b&minutes=` | Recent edits by others to these files. |
| GET | `/api/context` | | The context bundle injected into Claude, with ready-to-use `text`. |
| GET | `/api/pulse` | `?since=<ms>` | Done, review, running, stale, new decisions. |

</details>

---

## Security and privacy

- **Shared team token.** v0.1 trusts the `X-Batcave-User` header from anyone holding the token. Fine for a trusted team behind HTTPS or on a private network. Per-user tokens and SSO are on the roadmap. Do not expose an untrusted, public server.
- **What leaves a laptop.** Handle and name, presence, claims, repo-relative paths of files Claude edits, the first line of commands Claude runs, commit subjects, PR URLs, and whatever people or Claude post with `/batcave:say`. Never file contents or diffs. Prompts are not sent; the "now" line says things like "thinking", "editing Header.tsx" or "running npm test".
- **Opt out per repo** with `"shareActivity": false` in `.batcave.json`.
- **Requests never run themselves.** The injected context tells Claude not to act on a request unless the user picks it in `/batcave:requests`.
- **Secrets.** The token lives only in `~/.batcave/config.json` (mode 600) or environment variables. `.batcave.json` is for non-secret settings only.

---

## Deploying the server

The server is one process with a JSON file for state. Back up the data volume.

**Docker**

```bash
docker build -t batcave server
docker run -d --name batcave -p 4777:4777 \
  -v batcave-data:/data \
  -e BATCAVE_TEAM=acme -e BATCAVE_TEAM_TOKEN=<token> \
  batcave
```

**Fly.io, Render, Railway or a VM.** Use the Dockerfile in `server/`, mount a volume at `/data`, set `BATCAVE_TEAM` and `BATCAVE_TEAM_TOKEN`, and serve it over HTTPS. The event stream needs a proxy that does not buffer responses (nginx: `proxy_buffering off;`).

**Scale.** The JSON store is fine for teams of tens. Past that, swap `server/src/store.mjs` for Postgres; nothing else depends on how state is stored.

---

## Roadmap

**Shipped in v0.1:** board with claims, people with stats, rooms, decisions, requests, handoffs, guard, pulse, status line, dashboard, setup skill.

**Next:**

- [ ] **Room and People panes** in the Claude Desktop Code tab, beside your session.
- [ ] **Follow mode.** Watch a teammate's agent live, read only.
- [ ] **Shared plans.** `/batcave:plan` drafts a plan the team edits together; each step becomes a card.
- [ ] **Shared preview.** Tunnel a teammate's dev server into the room so PMs and designers see the running app.
- [ ] **Inline review** on diff cards, fed back into the owning agent's context.
- [ ] **Decision watcher.** Flag plans and diffs that contradict a pinned decision.
- [ ] **Per-user tokens and SSO**, multiple teams per server, Postgres store.
- [ ] **GitHub sync.** Import issues as cards and mark cards done on merge.

---

## FAQ

<details>
<summary><b>Is there one shared agent the whole team prompts?</b></summary>

No, on purpose. Each person's Claude runs on their own account. Requests, handoffs and shared context give most of the benefit of a shared agent while each person stays in control of their own.
</details>

<details>
<summary><b>Does it need a cloud sandbox?</b></summary>

No. Work happens in each person's local repo and branch, same as today.
</details>

<details>
<summary><b>What if the server goes down?</b></summary>

Claude Code keeps working. Hooks time out quietly, the status line shows `○ batcave offline`, and everything syncs again when the server is back.
</details>

<details>
<summary><b>Can non-engineers use it?</b></summary>

Yes. The dashboard at the server URL shows the board, people, rooms and decisions, and lets anyone add tasks, post, pin decisions and send requests to an engineer's Claude.
</details>

<details>
<summary><b>How much context does it add to my prompts?</b></summary>

A short block: your task, active decisions, the last few room messages, and pending requests. It is injected at session start and again only when it changes.
</details>

---

## License

MIT
