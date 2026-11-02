# Batcave for Claude Code

The Claude Code plugin for [Batcave](../README.md). It is a mod: besides the slash commands, MCP tools and command hooks every agent gets, it ships a hooks module that draws Batcave inside Claude Code and holds edits that would collide with a teammate's agent.

## What it draws

**The team band**, above the prompt, refreshed every 15 seconds and after every turn:

```text
▍batcave wayne-tech │ ● 5 online │ 1 request │ ◆ T-9 running │ tim › editing tokens.ts │ 12.4k tok saved   b board  t team  q requests
```

Narrow terminals drop the teammate activity, then the savings, then the buttons. When you start work with no claim and the prompt matches a backlog card, the band says `looks like T-10` and offers **claim T-10** on `c`.

The look is deliberately quiet: hairline frames, muted text, cyan only for live work and your claim, amber only for what needs you.

**The Batcave pane**, opened with `/cave` (or `/cave team`, `/cave requests`, `/cave stats`) or the band's buttons. Four tabs, switched with `1` to `4`:

| Tab | What it shows | Buttons |
|---|---|---|
| Board | Backlog, Claimed, Running, Review, Done | **Claim** on backlog cards and **Take over** on stale ones. Claiming asks Claude to create the branch and brief you. |
| Team | Each teammate's presence, agent, what it is doing now, and the week's numbers | |
| Requests | Asks from teammates for your agent | **Run on my agent** submits the request as your prompt. **Decline** answers it. |
| Stats | Tokens saved (dedupe and Alfred ranking), hook and Alfred latency (p50 and p95), and how often Alfred's suggestions are taken | |

**The guard pane.** When Claude is about to edit a file another teammate's agent changed recently, or to write a change that breaks a pinned decision, the edit is held in a pane:

```text
┌──────────────────────────────────────────────────────────┐
│ ▲ guard // src/theme/tokens.ts                           │
│   └ tim's agent edited it 4m ago on T-4                  │
│   editing now may overwrite their work                   │
│                                                          │
│ [2 cancel and ask them]   1 proceed                      │
└──────────────────────────────────────────────────────────┘
```

Cancel has the focus, so Enter keeps their work. Claude is told why it was stopped and to coordinate first. In a narrow terminal the pane is drawn in the band instead.

**Toasts** for new requests to your agent, handoffs to you, and decisions pinned by teammates.

## Hooks

| Hook | What it does |
|---|---|
| `session.start` | Reads `~/.batcave/config.json`, registers `/cave`, takes a first reading, and refreshes every 15 s with `$.clock.every`. |
| `turn.complete` | Refreshes after each main-loop turn. |
| `tool.call` | The guard, for `Edit`, `Write`, `MultiEdit` and `NotebookEdit`. Fails open if the server is unreachable. |
| `ui.render` `AbovePrompt` | The team band. |
| `ui.render` `Pane` | The Batcave pane and the guard pane. |
| `command.run` `cave` | Opens the pane on a tab. |

Calls: `$.http.fetch` to the Batcave server, `$.prompt.submit` when you press Claim or Run, `$.ui.open`, `$.ui.toast`, and `$.process.run` to read the config and mark the mod active.

Presence, activity and team-context injection stay in the plugin's command hooks (`hooks/hooks.json`), which are shared with every other agent. While the mod runs, the command-hook guard steps aside so you are never asked twice.

## Run it

Requirements: Claude Code 2.1.287 or later (mods load by default), and a configured Batcave (`/batcave:setup`).

```bash
claude plugin validate ./plugin      # from a clone of the repo
claude --plugin-dir ./plugin         # try it for one session
```

Or install from the marketplace:

```text
/plugin marketplace add solanki-aman/batcave
/plugin install batcave@batcave
```

## Limitations

- The band refreshes every 15 seconds and after each turn, not instantly.
- One band per session: another mod drawing `AbovePrompt` competes for the same line.
- The side pane needs a wide terminal; narrower ones get the band.
- On Claude Code versions without mods, the plugin still works through its command hooks, slash commands and MCP tools, and the guard asks through the normal permission prompt.

## License

MIT
