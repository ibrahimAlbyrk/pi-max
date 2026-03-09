---
name: tools/spawn_agent-short
description: Short description for the spawn_agent tool (used in system prompt tool list)
version: 1
---
Spawn a subagent for delegated tasks. BLOCKS until agent completes and returns result inline. Multiple agents in the same turn run in parallel automatically. Do NOT set background=true unless explicitly asked by user. Use when a task requires reading, searching, or analyzing code across multiple files. Do not use to read a single known file you are about to edit.
