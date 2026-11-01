---
description: Review requests teammates sent to your Claude, and choose which to run
---
Call `batcave_requests` and list the pending requests.

For each one, ask the user to choose: run, edit first, or decline. Never run a request without the user's explicit choice.
- Run: call `batcave_request_resolve` with `accept`, then do the task as if the user had typed it.
- Edit first: let the user rewrite it, then accept and do the rewritten version.
- Decline: call `batcave_request_resolve` with `decline`, and offer to post a short reason with `batcave_say`.
