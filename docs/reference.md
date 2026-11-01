# Reference

## What happens automatically

| Moment | Hook (Claude Code / Codex name) | Effect |
|---|---|---|
| Session starts | `SessionStart` | You show as online. Your agent gets your task, decisions, room messages, requests and handoffs. |
| You send a prompt | `UserPromptSubmit` | Your agent shows as running and gets the team context again only if it changed. |
| Your agent is about to edit | `PreToolUse` | The guard checks for recent edits by other teammates' agents. |
| Your agent edits or runs a command | `PostToolUse` | Your "now" line updates. `git commit` posts to your room. `gh pr create` moves your card to In review. |
| Your agent finishes a turn | `Stop` | Your agent shows as idle. |
| Session ends | `SessionEnd` | You show as offline. |

Every hook fails open with a 2.5 second timeout. If the server is slow or down, your agent keeps working and the status line says `○ batcave offline`.

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

## API reference

All `/api/*` routes except `/api/health` need `Authorization: Bearer <team token>` and `X-Batcave-User: <handle>` (optionally `X-Batcave-Name`). Responses are JSON.

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
| POST | `/api/requests` | `to`, `text`, `room` | Ask a teammate's agent. |
| POST | `/api/requests/:id/resolve` | `action: accept\|decline` | Recipient only. |
| POST | `/api/handoffs` | `task`, `to`, `summary`, `todos` | Owner only. Transfers the card. |
| GET | `/api/handoffs` | | Open handoffs to or from you. |
| POST | `/api/handoffs/:id/pickup` | | Recipient only. Returns the packet. |
| POST | `/api/events` | `type`, `files`, `command`, `summary`, `url` | Activity from hooks: `turn_start`, `turn_end`, `edit`, `command`, `commit`, `pr`. |
| GET | `/api/guard` | `?files=a,b&minutes=` | Recent edits by others to these files. |
| GET | `/api/context` | | The context bundle injected into agents, with ready-to-use `text`. |
| GET | `/api/pulse` | `?since=<ms>` | Done, review, running, stale, new decisions. |


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

## Design choices

- **Zero dependencies everywhere.** Node 18 built-ins only. The plugin works right after install, and the server is one `node` command.
- **State lives on the server, work lives on laptops.** The server never sees code: only file paths, branch names, commit subjects and the messages people choose to post.
- **Context is pushed, not pulled.** Decisions and room messages reach every agent through hooks, so nobody has to remember to ask. Injection is deduplicated per session to save tokens.
- **Fail open.** A missing server never blocks anyone's work.

## Repository layout

```
batcave/
├── .claude-plugin/marketplace.json   # lets /plugin marketplace add find the plugin
├── .claude/skills/batcave-setup      # symlink so the setup skill works inside this repo
├── cli/batcave.mjs                   # installer and shell commands
├── cli/installers.mjs                # per-agent config writers
├── plugin/                           # Claude Code plugin, and the shared runtime for every agent
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
│   ├── lib/agents.mjs                # per-agent payload and reply adapters
│   ├── lib/hookcore.mjs              # agent-independent hook logic
│   ├── lib/tools.mjs                 # the 18 tools, shared by MCP and the CLI
│   └── lib/client.mjs                # config and HTTP client
├── server/
│   ├── src/index.mjs                 # HTTP API, SSE, domain logic
│   ├── src/store.mjs                 # JSON persistence
│   ├── public/index.html             # dashboard
│   └── Dockerfile
└── assets/                      # the images in this README
```

## Scout

Batcave can use [Julia-1](https://huggingface.co/SupersonicLabs/Julia-1), an open decision model from Supersonic Labs, for small advisory calls. Julia-1 takes a state, a question and a closed set of answers, and returns a choice or a probability. It does not generate text.

### What it does in Batcave

| Call | Question type | Effect |
|---|---|---|
| Context ranking | one yes/no question per candidate note | Only decisions and room messages relevant to the current prompt and task are injected. When a task has five or fewer decisions, all are kept. |
| Decision spotting | choice among decision, question, blocker, update, chatter | Room messages that read like a decision get a "Pin as decision" suggestion in the dashboard. |

### Running it

```bash
batcave scout install                 # Python 3.9+, creates ~/.batcave/scout/venv, downloads the model
batcave scout start                   # foreground, http://127.0.0.1:4778
batcave scout start --detach          # background, log in ~/.batcave/scout/scout.log
batcave scout start --device mps      # Apple silicon GPU, or cuda
batcave scout status
batcave server --scout                # server and scout together
```

Or with Docker, next to the server: `docker build -t batcave-scout scout && docker run -d -p 4778:4778 batcave-scout`.

The server looks for Scout at `BATCAVE_SCOUT_URL` (default `http://127.0.0.1:4778`) every 30 seconds. Set `BATCAVE_SCOUT=off` to disable it, and `BATCAVE_SCOUT_TIMEOUT_MS` (default 900) to change the per-call budget.

### Sidecar API

| Method | Route | Body | Returns |
|---|---|---|---|
| GET | `/health` | | `ok`, `loaded`, `model`, `device`, `load_ms`, `error` |
| POST | `/decide` | `{ "state": "...", "questions": { "name": { "type": "choice", "instructions": "...", "criteria": { "key": "description" } } } }` | `{ "answers": {...}, "ms": 41.2 }` |
| GET | `/stats` | | call count and latency percentiles |

## Stats

`GET /api/stats` returns, since the server first started:

- `tokens`: `injected`, `savedDedupe`, `savedRanking`, `saved`, `savedPct`. Tokens are estimated as characters divided by four.
- `latency`: per key, `count`, `avg`, `p50`, `p95` over the last 400 samples. Keys are `api:<METHOD> <route>` (server time), `hook:<mode>` and `agent:<agent>` (end-to-end hook time reported by each client with its next request), and `scout:<call>`.
- `counters`: claims, guard checks and conflicts, requests, handoffs, decisions, messages by kind, scout calls and failures.
- `daily`: injected and saved tokens per day for the last 30 days.
- `scout`: whether Scout is enabled and ready, and which model and device it uses.

The same numbers appear in the dashboard's Stats tab, in `batcave stats`, and as "tok saved" in the status line.
