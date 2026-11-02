---
name: batcave-setup
description: Set up Batcave, the multiplayer layer for coding agents (Claude Code, Codex, Gemini CLI, Antigravity, Cursor, Copilot CLI, OpenCode). Use when someone wants to join their team's Batcave, connect another agent, deploy a Batcave server, fix a broken install, or asks how to get started.
---

# Batcave setup

Batcave connects each teammate's own coding agent to a shared server that holds the team's board, people, rooms, decisions, requests and handoffs. Every person keeps running their own agent under their own login, and teammates can use different agents; Batcave only shares state between sessions. Your job is to get the person from nothing to a passing doctor check, doing the work yourself and asking only for what you cannot know.

The scripts you will run live in the `scripts` folder of the Batcave plugin, two levels up from this skill's folder (`<plugin>/scripts/setup.mjs`, `doctor.mjs`, `statusline.mjs`). Resolve that absolute path first and use it in every command.

## Step 1: Figure out the role

Ask one question if it is not already clear: are they joining an existing team server, or setting one up for their team? Someone who has a server URL and a team token is joining. Someone who has neither is usually the admin and needs Step 2 first.

## Step 2: Deploy the server (admins only)

The server is in the `server` folder of the Batcave repo and has no dependencies beyond Node 18. Generate a strong team token with `node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"` and keep it for later.

For a quick local trial, run `BATCAVE_TEAM=<team name> BATCAVE_TEAM_TOKEN=<token> node server/src/index.mjs` from the repo root; it listens on port 4777. For a team, prefer Docker: `docker build -t batcave server` and then `docker run -d -p 4777:4777 -v batcave-data:/data -e BATCAVE_TEAM=<team> -e BATCAVE_TEAM_TOKEN=<token> batcave`. Any host that runs a container with a persistent volume works (Fly.io, Render, Railway, a VM). Put it behind HTTPS before sharing it outside a private network, because the token travels in a header.

Confirm it is up with `curl <url>/api/health`; the response should show the team name and `"auth": true`. Then tell the admin to share two things with teammates privately: the URL and the token. The token must never be committed to a repo.

## Step 3: Check prerequisites

Run `node --version` and confirm it is 18 or newer, and confirm `git` is installed. Ask which agents they use if it is not obvious; `npx github:solanki-aman/batcave agents` lists the ones found on the machine.

If they use agents other than Claude Code, Step 4 is a single command: `npx github:solanki-aman/batcave init --url <url> --token <token> --user <handle> --name "<name>"`, optionally with `--agent codex,cursor` to choose agents and `--repo` to add a Batcave section to the repo's `AGENTS.md`. It installs a runtime in `~/.batcave/runtime`, writes the config, and wires hooks, the MCP server and commands into each agent's own config with backups. Read its output back to the person, then go to Step 6.

For Claude Code, if the Batcave plugin is not installed yet, tell the person to run these two commands in Claude Code and then restart it, since you cannot run slash commands for them:

`/plugin marketplace add solanki-aman/batcave`
`/plugin install batcave@batcave`

## Step 4: Connect this machine

Ask for the server URL, the team token, a short lowercase handle (what teammates will type, like `aman`) and a display name. Ask whether they want the Batcave status line in Claude Code; recommend yes unless they already have a custom status line they care about.

Run `node <plugin>/scripts/setup.mjs --url <url> --token <token> --user <handle> --name "<name>"` and add `--statusline` if they agreed. The script writes `~/.batcave/config.json` with owner-only permissions, checks the server, and signs them in. If it reports an existing status line, ask before re-running with `--statusline --force`; it keeps a backup either way.

## Step 5: Optional repo settings

If the team wants shared defaults for a repo, create `.batcave.json` in the repo root with only non-secret fields, for example `{ "url": "https://batcave.example.com", "guardMinutes": 60 }`. Set `"shareActivity": false` there for repos where edit and command activity should not be posted. Never put the token in this file.

## Step 6: Verify

Run `node <plugin>/scripts/doctor.mjs` from inside the person's repo. Every line should be a check mark; warnings about the status line are fine if they declined it. If something fails, the doctor prints the fix; apply it and run doctor again.

Finish by telling them to restart their agents so the hooks load. In Claude Code and Gemini CLI they can try `/batcave:board`; in Cursor `/batcave-board`; in any agent they can simply ask for the board, and from any shell `batcave board` works. Mention the dashboard at the server URL for teammates who do not use a terminal, and that they sign in there with the same handle and token.

## Troubleshooting

To remove Batcave from other agents, run `batcave uninstall --agent <name>`; backups of edited files are kept as `.bak-batcave`. If hooks seem silent, run any hook with `BATCAVE_DEBUG=1` set to see errors; hooks are designed to fail open, so a down server never blocks Claude. A 401 means the token is wrong. A "did not answer" error means the URL is wrong, the server is down, or a VPN is needed. If the guard flags files from another machine with absolute paths, the person is outside a git repo; open Claude Code in the repo root instead.
