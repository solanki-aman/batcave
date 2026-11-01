# A day in Batcave

Five moments, end to end. Each diagram is exactly what the plugin and server do.

## 9:02 &nbsp; Aman opens Claude Code and already knows the score

The session-start hook signs him in and hands his agent the team's context before he types anything. The same happens in Codex, Gemini CLI, Cursor and Copilot CLI.

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
    Note over CC: The agent now knows: T-3 is in progress,<br/>"no new colors" is decided,<br/>Nate asked for a screenshot
    CC-->>Aman: ready, with the team in mind
```

## 9:15 &nbsp; Aman claims the next task

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

## 10:40 &nbsp; The guard stops a collision before it happens

Aman's Claude goes to edit `tokens.ts`. Nate's Codex edited it four minutes ago. Different vendors, same guard.

```mermaid
sequenceDiagram
    autonumber
    participant N as Nate's Codex
    participant S as Batcave server
    participant A as Aman's Claude
    participant H as PreToolUse hook
    actor Aman

    N->>S: PostToolUse: edit src/theme/tokens.ts
    Note over S: touch recorded (Nate, T-4, 10:36)
    A->>H: about to Edit src/theme/tokens.ts
    H->>S: GET /api/guard?files=src/theme/tokens.ts
    S-->>H: conflict: Nate's agent, 4m ago, T-4
    H-->>A: permissionDecision: ask
    A-->>Aman: "Nate's agent edited it 4m ago. Allow this edit?"
    Aman->>A: no
    A->>S: batcave_say to the T-4 room: "Can the email token land with T-4?"
```

## 11:05 &nbsp; Nate asks Aman's agent for a favor

Requests are how one teammate gets help from another's agent without anyone borrowing a subscription.

```mermaid
sequenceDiagram
    autonumber
    actor Nate
    participant S as Batcave server
    participant AC as Aman's Claude
    actor Aman

    Nate->>S: "@aman-agent add a screenshot to the PR"
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

## 5:30 &nbsp; Aman hands off and logs off

Handoffs move the card and carry everything the next person needs.

```mermaid
sequenceDiagram
    autonumber
    actor Aman
    participant AC as Aman's Claude
    participant S as Batcave server
    participant PC as Priya's Cursor
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

## The task lifecycle

<p align="center"><img src="assets/lifecycle.svg" alt="Task lifecycle: backlog, claimed, agent running, in review, done" width="100%"></p>

A claim with no agent activity for 24 hours (configurable) is marked **stale**. Anyone can take it over, and the room records who took it from whom.
