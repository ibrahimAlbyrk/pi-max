---
name: dps/tool-task-protocol
description: Task management protocol and workflow when using the task tool
version: 1
dps:
  layer: 2
  priority: 2
  conditions:
    - tool_active: task
---
## Task Management Protocol

When working on multi-step projects, use the task tool for structured tracking.

**Workflow:**
1. PLAN first — break work into discrete, trackable tasks before writing code
2. Use `bulk_create` with indented text to create task groups and tasks in one call
3. `start` a task before working on it to set active context
4. `complete` it when done, then `start` the next
5. One task at a time — finish current before moving to next

**Task Groups:**
- Groups (G1, G2, ...) are organizational containers — they have no status and cannot be started/completed
- Tasks (#1, #2, ...) are actionable work items — every task can be started and completed
- Use groups to organize related tasks (e.g., "Backend API", "Authentication")

**Bulk create format (text param):**
```
Group Name [priority] #tag
  Task A [high] @agent ~30m
  Task B [medium]
```
Top-level items with children become groups. Indent = hierarchy.

**Status tracking:** Update status as you work. Add notes with `add_note` for important context. Use `block` with a reason when blocked on external input.
