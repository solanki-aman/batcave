<p align="center">
  <img src="docs/assets/hero.svg" alt="Batcave: multiplayer coding agents" width="100%">
</p>

<p align="center">
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-0C1116?style=flat-square"></a>
  <img alt="Node 18+" src="https://img.shields.io/badge/node-18%2B-0C1116?style=flat-square">
  <img alt="Zero dependencies" src="https://img.shields.io/badge/dependencies-0-0C1116?style=flat-square">
  <img alt="Supported agents: 7" src="https://img.shields.io/badge/agents-7-2A4A52?style=flat-square">
  <img alt="MCP server" src="https://img.shields.io/badge/MCP-server-2A4A52?style=flat-square">
</p>

<p align="center">
  <a href="https://solanki-aman.github.io/batcave/"><b>Website</b></a> ·
  <a href="#see-it-in-action"><b>Demo</b></a> ·
  <a href="#rooms-shared-work-one-place"><b>Rooms</b></a> ·
  <a href="#quick-start"><b>Quick start</b></a> ·
  <a href="docs/walkthrough.md"><b>Walkthrough</b></a> ·
  <a href="docs/reference.md"><b>Reference</b></a>
</p>

---

**Batcave is a shared workspace for teams whose developers each run a coding agent.** It gives every agent on the team one board with claims, live presence, pinned decisions, requests between teammates, handoffs, and a guard that stops two agents from overwriting the same file. It works across vendors: one teammate on Claude Code, another on Codex, a third on Cursor, all on the same board.

Everyone keeps their own agent, their own machine and their own account. Batcave shares state, never credentials, and never runs one person's agent for another.

## See it in action

<p align="center"><img src="docs/assets/terminal.gif" alt="The Batcave mod in Claude Code: the team band, a suggested card claimed with one key, a teammate request, the /cave pane with board, team, requests and stats tabs, and the guard holding an edit" width="100%"></p>

## Works with

| Agent | Install | Team context | Activity | Guard |
|---|---|---|:---:|---|
| Claude Code | plugin with a mod | session start, every prompt | ✓ | holds the edit in a pane |
| Codex CLI | `batcave init` | session start, every prompt | ✓ | asks |
| Gemini CLI, Antigravity | `batcave init` | session start, every prompt | ✓ | blocks once |
| Cursor | `batcave init` | session start, after tool calls | ✓ | blocks once |
| GitHub Copilot CLI | `batcave init` | session start, after tool calls | ✓ | asks |
| OpenCode | `batcave init` | `AGENTS.md` and tools | ✓ | blocks once |
| Any MCP client | manual | `AGENTS.md` | tools only | no |

*Blocks once* is for agents whose hooks cannot pause for a question: Batcave stops the first edit, the agent explains why, and the retry goes through if you approve.

## Inside Claude Code

In Claude Code, Batcave is a mod. It draws the team above your prompt and holds risky edits in a pane. The recording above draws the mod's real output against a live server, inside a terminal mockup.

```text
▍batcave wayne-tech │ ● 5 online │ 1 request │ ◆ T-9 running │ tim › editing tokens.ts │ 12.4k tok saved   b board  t team  q requests
```

- **Team band**, live above the prompt: who is online, what teammates' agents are doing, requests for you, your claim, tokens saved.
- **`/cave` pane** with Board (claim with one key), Team, Requests (Run on my agent, Decline) and Stats tabs.
- **Guard pane**: an edit to a file a teammate's agent just changed waits for Proceed or Cancel. Trivial overlaps pass with a toast.
- **Toasts** for new requests, handoffs and decisions.

Details in the [plugin README](plugin/README.md).

## Rooms: shared work, one place

A room is where a piece of work lives. Join it and you have everything you need to start: the branch, your own checkout of it, who owns which part, how to run and test, and the rules everyone's agent follows.

```text
#router-rewrite · cards T-12, T-13
branch    aman/t-12-decision-router         you: ↓1 behind, tim pushed    [p pull]
members   Aman      no slice
          Tim       router core · src/router/**
          Barbara   (dashboard)
run       dev: npm run dev · test: npm test -- router · env: ROUTER_MODEL_URL, EDGE_TOKEN
rules     Mock the edge client in tests.
```

- **One branch, a checkout each.** `batcave room join router-rewrite` adds you and creates a git worktree of the room's branch next to your repo, so your agent never disturbs your main checkout. `--here` switches the current one instead.
- **Stay in sync without fetching.** Every push is recorded with the files it carried. The band shows `↓1 · tim pushed` with a pull key, and an edit to a file a teammate pushed is held with **pull first**.
- **Slices.** `--slice "src/router/**"` claims part of the room. Edits to someone else's slice are held, and Alfred routes questions to whoever owns the code.
- **Run, test and rules.** `batcave room set router-rewrite --test "npm test -- router" --env ROUTER_MODEL_URL --rules "Mock the edge client in tests."` Every member's agent gets them as context, so everyone tests the same way. Env stores names, never values.
- **Rename and invite.** `batcave room rename`, `batcave room invite router-rewrite @tim`, or from the dashboard. Invites show up as a toast. `batcave room new "pricing experiments" @tim @lucius` starts a room that isn't tied to a card.

In Claude Code, the `/cave` Room tab shows all of this. Agents use one `batcave_room` tool for show, new, join, leave, rename, invite, set and slice.

### A group chat where agents are teammates

Every room has a chat. People talk there, and so do their agents, but an agent only speaks when Alfred brings it in. Alfred never writes a word himself. He decides when an LLM is worth calling, and the LLM is always a teammate's own agent on their own account. Here a team is replacing an LLM router with a small decision model:

```text
#t12-decision-router · T-12 Route support tickets with a decision model

Tim      Shadow run is done. The decision model picks the same queue as our LLM
         router on most tickets, and it answers on CPU in milliseconds.
Tim      lunch at noon?
           · alfred: chatter, stays quiet
Barbara  What happens when it isn't sure? Support can't lose escalations.
Lucius   Fall back to the LLM router below a confidence cutoff. Which cutoff, though?
Aman     @alfred how do teams usually pick that cutoff?
           · alfred: @alfred → Aman's Claude Code, runs now
Aman's agent
         Pick it from the shadow-run log, not by feel: the lowest confidence where
         it never misroutes an escalation. Everything below goes to the LLM router.
         Recheck it weekly from the outcome log.                [Lucius: helpful]
Lucius   Should the fallback also cover languages we didn't shadow-test?
Barbara  Not sure.
Lucius   No idea either.
           · alfred: 45s quiet, open question, room stuck (0.86)
           · alfred: Tim's Codex owns the router, auto weigh-in on → brought in
Tim's agent
         Yes. Untested languages skip the decision model and go straight to the
         LLM router. The shadow run already logs language, so it is one check at
         the top of route.ts.                                   [Barbara: helpful]
```

What happened:

- **Chatter.** "lunch at noon?" Alfred stays quiet.
- **`@alfred`.** Aman asks how to pick the confidence cutoff. His own Claude Code answers at once, with the thread, the task and the pinned decisions in front of it.
- **Stuck.** Nobody knows whether untested languages need the fallback. After 45 seconds of quiet, Alfred judges the room stuck and brings in the agent best placed to answer: Tim's Codex, which owns the router code.
- **Auto weigh-in.** Tim turned it on, so his agent joins on its own. Without it, Tim gets a one-key offer.
- **Feedback.** Teammates mark answers helpful or not, and Alfred's calls get measured against that.

`@alfred` always gets an answer. From someone without an agent, like Barbara on the dashboard, it goes to a teammate's agent that has auto weigh-in on. Details in [the reference](docs/reference.md#alfred-in-rooms).

## Quick start

**1. Start a server.** One person, once per team. Node 18 or newer; nothing to install.

```bash
git clone https://github.com/solanki-aman/batcave && cd batcave
export BATCAVE_TEAM=wayne
export BATCAVE_TEAM_TOKEN=$(node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))")
node server/src/index.mjs
```

For a real team, deploy `server/Dockerfile` behind HTTPS. See [Deploying](docs/reference.md#deploying-the-server).

**2. Connect your agent.** Every teammate.

Claude Code:

```text
/plugin marketplace add solanki-aman/batcave
/plugin install batcave@batcave
/batcave:setup
```

Every other agent, detected automatically:

```bash
npx github:solanki-aman/batcave init \
  --url https://batcave.example.com --token <team token> \
  --user aman --name "Aman" --repo
```

`init` writes each agent's own config with a backup, and `--repo` adds a short Batcave section to the repo's `AGENTS.md`. Undo with `batcave uninstall`.

**3. Use it.** Ask your agent for the board, or from any shell:

```bash
batcave board
batcave claim T-14
batcave decide "Reuse surface tokens. No new colors." --pattern '#[0-9a-f]{6}'
```

## Features

| | |
|---|---|
| **Board and claims** | Backlog, Claimed, Agent running, In review, Done. Cards move on their own as agents start work, open PRs and merge. Stale claims can be taken over. |
| **People** | Who is online, which agent they use, what it is doing now, and the week's shipped work, open PRs and reviews owed. |
| **Decisions** | Pin a decision once; every teammate's agent receives it as context, and edits that break it are held. |
| **Requests** | Ask a teammate's agent to do something. It runs only if they choose to, in their own session. |
| **Guard** | Warns before an agent edits a file another teammate's agent changed recently, across vendors. |
| **Handoff** | Branch, summary, todos and decisions in one packet. The receiver starts with full context. |
| **Rooms and pulse** | A chat per task, agents post commits to it, and a briefing of what changed since you last looked. |
| **Dashboard** | The board, people, rooms and decisions in a browser for teammates who never open a terminal. |
| **Stats** | Hook and API latency (p50, p95), tokens injected into agents, and tokens saved, in the dashboard, `batcave stats` and the status line. |
| **Alfred** | Optional. Julia-1, a small open decision model, runs on CPU next to the server to rank which notes each agent needs and to spot decisions in chat. |

<p align="center"><img src="docs/assets/dashboard.gif" alt="Batcave dashboard updating live" width="100%"></p>

## How it works

<p align="center"><img src="docs/assets/architecture.svg" alt="Each teammate's agent exchanges state with one Batcave server, which also serves the dashboard" width="100%"></p>

- **Server.** One per team. Holds people, tasks, rooms, decisions, requests, handoffs and recent file edits. JSON API, live event stream and dashboard. Zero dependencies.
- **Claude Code mod.** A hooks module that draws the team band, the `/cave` pane and the guard pane inside Claude Code.
- **Hooks.** One script serves every agent; small adapters translate each vendor's payloads. They report presence and activity and push team context into the agent. Every hook fails open with a short timeout.
- **MCP server.** Twenty tools (`batcave_board`, `batcave_claim`, `batcave_request`, ...) so any agent can read and change shared state.
- **CLI.** `batcave init` wires agents up; `batcave board`, `people`, `claim`, `say` and more work from any shell.

See the [walkthrough](docs/walkthrough.md) for five sequence diagrams of a team's day, and the [reference](docs/reference.md) for hooks, configuration and the API.

## Token savings and Alfred

Every token Batcave sends to an agent is counted, and so is every token it avoids sending:

- **Dedupe.** The server remembers what each session last received and only resends context when it changed.
- **Ranking.** With Alfred running, decisions and room messages are scored for relevance to the current prompt and task, and only the relevant ones are sent.

Alfred is [Julia-1](https://huggingface.co/SupersonicLabs/Julia-1) by Supersonic Labs (Apache-2.0, 144M parameters), a decision model that picks among supplied answers instead of generating text. It runs locally on CPU and is entirely optional: without it, Batcave uses plain rules.

```bash
batcave alfred install          # downloads Julia-1 (~580 MB) into ~/.batcave/alfred
batcave server --alfred         # starts the server and Alfred together
batcave stats                  # latency and savings
```

Beyond ranking, Alfred makes the small calls a teammate would:

- **"Looks like T-9."** Start work without a claim and it offers the matching card.
- **Duplicates.** A new task that repeats an open one gets flagged.
- **Guard sorting.** Trivial overlaps pass with a note; real ones stop.
- **Decision check.** An edit that breaks a pinned decision is held with the decision quoted. Pin with `--pattern` for a hard rule that works without Alfred.
- **Routing.** `batcave ask team ...` or `@team-agent` goes to whoever knows that code.
- **Commit linking.** Commits land on the right card, even from `main`.
- **Paused, not stale.** "Back Monday" keeps a claim from going stale.
- **Handoff check.** No handoff leaves without done, left and how to test.
- **Toast filter.** Only what matters to you interrupts you.
- **@alfred in rooms.** Alfred decides when an LLM joins a conversation, and that LLM is a teammate's own agent. `@alfred` always gets an answer, from your agent or, if you have none, from a teammate's. A stuck room gets an agent too: whoever is best placed weighs in, on `w` or on its own. Turn on auto weigh-in and your agent joins the chat on its own, like a teammate.

Every call falls back to plain rules without Alfred, and every judgment is logged with its outcome, so `batcave stats` shows how often Alfred is right.

Alfred only advises. It never blocks an edit, grants access or accepts a request. Calls time out after 900 ms and fall back to rules. See [Alfred reference](docs/reference.md#alfred).

## Security and privacy

- **What leaves a laptop:** handle and name, presence, claims, repo-relative paths of edited files, the first line of commands, commit subjects, PR URLs and anything posted to a room. Never file contents, diffs or prompts.
- **Opt out per repo** with `"shareActivity": false` in `.batcave.json`.
- **Alfred is local.** It runs next to your server; no team data goes to a model provider.
- **Requests never run themselves.** Agents are told not to act on one unless the user picks it.
- **Auth:** v0.2 uses one team token and trusts the handle a client sends. Run it on a private network or behind HTTPS for a trusted team. Per-user tokens and SSO are on the roadmap.

## Roadmap

- Room and People panes inside the Claude Desktop Code tab
- Follow mode: watch a teammate's agent live, read only
- Shared plans whose steps become cards
- Shared preview of a teammate's running app
- Per-user tokens, SSO, multiple teams per server, Postgres
- GitHub sync for issues and merges

## Contributing

Issues and pull requests are welcome. The codebase has no dependencies and no build step: `node server/src/index.mjs` runs the server, and `node cli/batcave.mjs help` runs the CLI from a clone. Adapters live in `plugin/lib/agents.mjs` and installers in `cli/installers.mjs`; adding an agent usually means one entry in each.

## License

[MIT](LICENSE)
