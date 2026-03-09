---
name: tools/spawn_agent-short
description: Short description for the spawn_agent tool (used in system prompt tool list)
version: 1
---
Spawn a subagent for delegated tasks. Default is foreground (blocking): waits until agent completes, returns result inline. Set background=true only when you need to continue working while the agent runs. Use when a task requires reading, searching, or analyzing code across multiple files. Do not use to read a single known file you are about to edit.
