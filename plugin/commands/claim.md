---
description: Claim a task from the board and start working on it
argument-hint: "<task id, e.g. T-14>"
---
Claim task $ARGUMENTS for the user.

1. Call `batcave_claim` with `task` set to the id. If it says the task is claimed by someone else, stop and tell the user who has it; suggest `/batcave:ask` to request a handoff. If the task is stale and the user wants it, call again with `force: true` only after they confirm.
2. If the result says the user already holds other active tasks, ask whether to park them (`batcave_release`), hand them off (`/batcave:handoff`), or keep both.
3. Create and switch to the returned branch: `git fetch` if needed, then `git switch -c <branch>` (or `git switch <branch>` if it exists). Do not touch uncommitted work without asking; if the tree is dirty, ask whether to stash or use a worktree (`git worktree add ../<repo>-<task id> -b <branch>`).
4. Summarize in three lines: the task, the branch, and the team decisions that apply. Then ask the user how they want to start.
