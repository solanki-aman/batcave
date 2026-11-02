---
description: Read or manage a room (join, invite, rename, set its branch, run commands and rules)
argument-hint: "[room] | join <room> [slice] | new <name> [@handles] | invite <room> @handle | rename <room> <name> | set <room> ..."
---
Arguments: $ARGUMENTS

With no arguments or just a room name, call `batcave_room_read` (room: the name if given) and show the messages in a code block. If someone asked a question the user's work answers, say so in one line.

Otherwise call `batcave_room` with the matching action: `join` (with `slice` if the user named paths they will own), `new`, `invite`, `rename`, `set` (branch, setup, dev, test, preview, lint, env names, rules, add_task) or `slice`. For `join`, show the room card it returns, then offer to run the worktree commands it suggests; do not run git commands without the user's yes.
