---
description: Hand your task to a teammate with a summary and open todos
argument-hint: "<handle> [task id]"
---
Hand off work to a teammate. Arguments: $ARGUMENTS (handle, then optional task id; default is the active task).

1. Make sure the work is committed and the branch is pushed (`git push -u origin <branch>`). Ask before committing anything.
2. Write a summary of at most eight lines: goal, what is done, what is not, gotchas, how to test.
3. List the open todos as short items.
4. Show the summary and todos to the user, then call `batcave_handoff` once they approve. If Batcave sends it back because a part is missing, fill that part in and ask the user again.
