---
description: Pin a team decision that every teammate's Claude will follow
argument-hint: "<decision>"
---
Pin this decision with `batcave_decide`: $ARGUMENTS

Rewrite it as one short, testable sentence if needed (for example "Reuse surface tokens. No new colors."), confirm the wording with the user, then pin it team-wide unless they say it only applies to the current task's room. If no arguments were given, call `batcave_decisions` and list the current ones.
