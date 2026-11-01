---
description: Send a request to a teammate's Claude
argument-hint: "<handle> <what you need>"
---
Send a request to a teammate's Claude. Arguments: $ARGUMENTS

The first word is the teammate's handle and the rest is the ask. Make the ask self-contained (task id, file or PR, what done looks like), then call `batcave_request`. Tell the user it runs only if the teammate accepts it.
