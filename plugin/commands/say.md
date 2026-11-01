---
description: Post a message to the room, or share a summary of what your Claude just did
argument-hint: "<message> | summary"
---
If the arguments are "summary" or empty, write a two-line summary of what was done in this session since the last post (what changed, tests, commit), and post it with `batcave_say` using `kind: "agent"`. Show the user the text before posting and post only after they agree.

Otherwise post exactly this as the user, with `kind: "human"`: $ARGUMENTS
