---
description: Send a request to a teammate's agent
argument-hint: "<handle> <what you need>"
---
Send a request to a teammate's agent. Arguments: $ARGUMENTS

The first word is the teammate's handle and the rest is the ask. If the first word is `team` (or there is no handle), pass `to: "auto"` and Batcave picks the teammate best placed to take it. Make the ask self-contained (task id, file or PR, what done looks like), then call `batcave_request`. Tell the user it runs only if the teammate accepts it.
