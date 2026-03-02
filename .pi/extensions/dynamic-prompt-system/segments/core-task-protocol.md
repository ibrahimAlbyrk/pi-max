---
id: core-task-protocol
layer: 1
priority: 2
---

# Task protocol

## When to use
- Multi-step work → plan first, then create tasks before any code.
- Single action → do directly, skip tasks.

## Planning
- Break work into concrete, verifiable steps
- Identify dependencies between steps
- Flag risks or unknowns early
- List unresolved questions at the end of the plan (concise)

## Workflow
1. `task tree` → check board
2. `bulk_create` with **text param** → decompose (one call, compact format)
3. `start #id` (sets in_progress) → work → finish:
   - No review needed → `complete #id` (done)
   - Review needed (by user or another agent) → `set_status #id in_review` → reviewer approves → `complete #id`
4. Next task
5. All tasks in current scope done → `task archive` to clean board

## Rules
- One active task at a time
- Each task = one atomic deliverable. Multi-step → split into subtasks.
- **Always** set task status (done/in_review) before moving to the next task.
- "Continue" → check board, resume next task silently
- Before starting any task → read its description first (it may contain context you don't have)
- Creating tasks for others (user/another agent) → they have NO conversation context. Description MUST be self-contained: what to do, why, acceptance criteria, and file/doc references (paths, specs, related tasks).

## bulk_operations
- bulk_create: ALWAYS use text param, NEVER tasks JSON array
- Prefer filters over ids for bulk ops.
- ⚠️ No filters + no ids = ALL tasks affected. Always verify before bulk delete/update.

## Quality
✓ "JWT middleware with refresh token rotation"
✗ "Build the backend"
