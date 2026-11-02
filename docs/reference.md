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
| POST | `/api/tasks` | `title`, `description`, `source`, `allowDuplicate` | Create a backlog task. Returns `possibleDuplicate` when it repeats an open one. |
| GET | `/api/tasks/:id` | | One task. |
| POST | `/api/tasks/:id/claim` | `branch`, `force` | Claim. 409 if someone else holds a fresh claim. |
| POST | `/api/tasks/:id/release` | | Back to backlog. |
| POST | `/api/tasks/:id/status` | `status`, `pr`, `reviewer` | Move a card. |
| GET | `/api/rooms` | | Rooms. |
| GET | `/api/rooms/:id/messages` | `?limit=` | Recent messages. |
| POST | `/api/rooms/:id/messages` | `text`, `kind`, `reply_to` | Post. `@handle-agent` creates a request; `@team-agent` routes it; `@alfred` hands the thread to an agent. `reply_to` links an agent's answer to an Alfred request. |
| POST | `/api/messages/:id/feedback` | `helpful` | Rate an agent's answer to an Alfred request. |
| GET | `/api/decisions` | `?room=` | Active decisions. |
| POST | `/api/decisions` | `text`, `room`, `pattern`, `fromMessage` | Pin a decision. `pattern` is an optional regex for changes that break it. |
| POST | `/api/decisions/check` | `text`, `file` | Pinned decisions a plan or change would break. |
| POST | `/api/decisions/:id/retire` | | Retire a decision. |
| GET | `/api/requests` | `?box=inbox\|sent&status=` | Your requests. |
| POST | `/api/requests` | `to` (handle or `auto`), `text`, `room` | Ask a teammate's agent. |
| POST | `/api/requests/:id/resolve` | `action: accept\|decline` | Recipient only. |
| POST | `/api/handoffs/check` | `summary`, `todos` | Which of done, left, test is missing. |
| POST | `/api/handoffs` | `task`, `to`, `summary`, `todos` | Owner only. Transfers the card. Returns `missing`. |
| GET | `/api/handoffs` | | Open handoffs to or from you. |
| POST | `/api/handoffs/:id/pickup` | | Recipient only. Returns the packet. |
| POST | `/api/events` | `type`, `files`, `hint`, `command`, `summary`, `branch`, `url` | Activity from hooks: `turn_start`, `turn_end`, `edit`, `command`, `commit`, `pr`. |
| GET | `/api/guard` | `?files=a,b&minutes=&change=` | Recent edits by others to these files, with `severity` (`low` or `real`), and `breaks`: decisions the change goes against. |
| GET | `/api/context` | | The context bundle injected into agents, with ready-to-use `text`. |
| POST | `/api/notify-filter` | `items: [{kind, text, room}]` | Which events deserve a toast. |
| POST | `/api/feedback` | `id`, `outcome` | Outcome of an Alfred suggestion. |
| GET | `/api/alfred/log` | `?limit=` | Recent Alfred judgments and outcomes. |
| POST | `/api/sweep` | | Run the paused-claim check now. |
| GET | `/api/pulse` | `?since=<ms>` | Done, review, running, stale, new decisions. |


## Deploying the server

The server is one process with a JSON file for state. Back up the data volume.

**Docker**

```bash
docker build -t batcave server
docker run -d --name batcave -p 4777:4777 \
  -v batcave-data:/data \
  -e BATCAVE_TEAM=wayne -e BATCAVE_TEAM_TOKEN=<token> \
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
│   ├── lib/tools.mjs                 # the 19 tools, shared by MCP and the CLI
│   └── lib/client.mjs                # config and HTTP client
├── server/
│   ├── src/index.mjs                 # HTTP API, SSE, domain logic
│   ├── src/store.mjs                 # JSON persistence
│   ├── public/index.html             # dashboard
│   └── Dockerfile
└── assets/                      # the images in this README
```

## Alfred

Batcave can use [Julia-1](https://huggingface.co/SupersonicLabs/Julia-1), an open decision model from Supersonic Labs, for small advisory calls. Julia-1 takes a state, a question and a closed set of answers, and returns a choice or a probability. It does not generate text.

### What it does in Batcave

| Call | Question type | Effect |
|---|---|---|
| Context ranking | one yes/no question per candidate note | Only decisions and room messages relevant to the current prompt and task are injected. When a task has five or fewer decisions, all are kept. |
| Decision spotting | choice among decision, question, blocker, update, chatter | Room messages that read like a decision get a "Pin as decision" suggestion in the dashboard. |
| Card matching | choice among backlog cards, or none | With no claim, a prompt that matches a card adds "looks like T-9" to the context and a Claim button to the mod band. |
| Duplicates | yes/no per open card | A new task that repeats an open one is flagged `possibleDuplicate` and badged on the board. |
| Guard sorting | yes/no: could these changes conflict? | Trivial overlaps (imports, unrelated hunks) pass with a note instead of a stop. |
| Decision check | yes/no per pinned decision: does this change go against it? | An edit that breaks a decision is held like a guard conflict, with the decision quoted. Only answers at 0.7 or above count (`BATCAVE_DECISION_BAR`). A decision pinned with a `pattern` regex is checked on every edit, with or without Alfred. |
| Request routing | choice among teammates, from claims, roles and recent files | `to: "auto"`, `batcave ask team ...` and `@team-agent` send the ask to the best-placed teammate. |
| Commit linking | branch first, then a choice among your open cards | Commits land in the right card's room, even on `main`. |
| Paused claims | yes/no: did the owner say they will come back? | A quiet claim whose owner said "back Monday" is marked paused instead of stale. Swept every 10 minutes. |
| Handoff check | three yes/no: done, left, how to test | `batcave_handoff` sends the summary back when a part is missing. |
| Toast filter | yes/no per event: worth interrupting now? | The mod only toasts what matters to you. Requests and handoffs always toast. |

Every call has a rule-based fallback (keyword overlap and regexes), so all of the above works without Alfred, less sharply.

### @alfred in rooms

Alfred never writes text. He decides when an LLM should join a room conversation, and that LLM is always a teammate's own coding agent on their own account.

| Trigger | Who answers | Runs when |
|---|---|---|
| `@alfred ...` from someone with an agent | the asker's own agent | at once in the Claude Code mod; at their next prompt in other agents |
| `@alfred ...` from someone without one (dashboard) | the best-placed agent among teammates with auto weigh-in on | at once; if nobody has it on, when the chosen teammate presses **weigh in** (`w`) |
| No mention, room goes quiet | a participant's agent | only if Julia-1 judges the room stuck; at once if they turned on auto weigh-in, otherwise when they press **weigh in** |

The agent receives a brief with the room's thread, its task and the pinned decisions, answers in at most 120 words with `batcave_say` (`reply_to` the request id), and does not change files unless asked. Quiet-room offers need Julia-1: it asks whether a question is open, whether the room is stuck, whether an outside answer would help and whether it is just chat, and offers only above `BATCAVE_SPEAK_BAR` (0.75). It waits `BATCAVE_ALFRED_PAUSE_MS` (45 s) after the last message, so it does not cut into people mid-conversation, and brings an agent in every time it judges the room stuck. While one agent is answering in a room, Alfred does not start a second. Teammates mark answers helpful or not in the dashboard, which feeds the outcome log.

**Auto weigh-in** is a per-person opt-in (`batcave auto-weigh-in on`, the Team tab in `/cave`, or the People view in the dashboard). With it on, Alfred's offers to you run on your agent without a key press, every time. In Claude Code the mod never cuts into a running turn: it waits for the current one to finish. Other agents pick it up at the next prompt.

### Outcome log

Each judgment is logged with its input, answer, source (`alfred` or `rules`) and confidence, in the store and in `alfred-decisions.jsonl` next to the data file. Outcomes are attached when they happen: a suggested card claimed or not, a routed request accepted or declined, a suggested pin pinned, a guard Proceed or Cancel, a paused owner returning. `GET /api/stats` reports the acceptance rate per call under `alfred.quality`, and `GET /api/alfred/log` returns recent entries. This is the data you would fine-tune Julia-1 on later.

### Running it

```bash
batcave alfred install                 # Python 3.9+, creates ~/.batcave/alfred/venv, downloads the model
batcave alfred start                   # foreground, http://127.0.0.1:4778
batcave alfred start --detach          # background, log in ~/.batcave/alfred/alfred.log
batcave alfred start --device mps      # Apple silicon GPU, or cuda
batcave alfred status
batcave server --alfred                # server and alfred together
```

Or with Docker, next to the server: `docker build -t batcave-alfred alfred && docker run -d -p 4778:4778 batcave-alfred`.

The server looks for Alfred at `BATCAVE_ALFRED_URL` (default `http://127.0.0.1:4778`) every 30 seconds. Set `BATCAVE_ALFRED=off` to disable it, and `BATCAVE_ALFRED_TIMEOUT_MS` (default 900) to change the per-call budget.

### Sidecar API

| Method | Route | Body | Returns |
|---|---|---|---|
| GET | `/health` | | `ok`, `loaded`, `model`, `device`, `load_ms`, `error` |
| POST | `/decide` | `{ "state": "...", "questions": { "name": { "type": "choice", "instructions": "...", "criteria": { "key": "description" } } } }` | `{ "answers": {...}, "ms": 41.2 }` |
| GET | `/stats` | | call count and latency percentiles |

## Stats

`GET /api/stats` returns, since the server first started:

- `tokens`: `injected`, `savedDedupe`, `savedRanking`, `saved`, `savedPct`. Tokens are estimated as characters divided by four.
- `latency`: per key, `count`, `avg`, `p50`, `p95` over the last 400 samples. Keys are `api:<METHOD> <route>` (server time), `hook:<mode>` and `agent:<agent>` (end-to-end hook time reported by each client with its next request), and `alfred:<call>`.
- `counters`: claims, guard checks and conflicts, requests, handoffs, decisions, messages by kind, alfred calls and failures.
- `daily`: injected and saved tokens per day for the last 30 days.
- `alfred`: whether Alfred is enabled and ready, which model and device it uses, and `quality`: decisions, outcomes and acceptance rate per call and source.

The same numbers appear in the dashboard's Stats tab, in `batcave stats`, and as "tok saved" in the status line.
