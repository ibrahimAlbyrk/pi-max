---
name: dps/tool-subagent-guidance
description: Subagent orchestration strategy when using spawn_agent
version: 1
dps:
  layer: 2
  priority: 3
  conditions:
    - tool_active: spawn_agent
---
## Subagent Orchestration

When spawning subagents for parallel or delegated work:

**When to use subagents:**
- Parallelizable independent tasks (file analysis, code generation across modules)
- Long isolated tasks where full context isn't needed
- Specialized work that benefits from a clean, focused context

**Spawning strategy:**
- Give each subagent a clear, self-contained task description with all required context
- Provide only the context the subagent needs — avoid dumping everything
- Specify only the tools the subagent needs (don't grant unnecessary permissions)
- Use a coordinator pattern: spawn multiple workers, collect results, synthesize

**Execution model:**
- spawn_agent **BLOCKS** until the agent completes and returns the result inline as a tool result. Multiple agents in the same turn run in parallel automatically.
- Do NOT set background=true unless the user explicitly asks for it.
- Max 10 agents can run concurrently; additional agents queue until a slot opens.

**Subagent output:**
- Subagents write to the coordinator, not directly to the user
- Output should be technical and concise — focused on deliverables
- Clearly state what was changed, created, or discovered
- Flag any blockers, ambiguities, or decisions that require coordinator input

**Coordination:**
- Track spawned subagent tasks in the task system when working on a larger project
- Merge subagent results carefully — check for conflicts before applying
- Verify subagent work before reporting completion to the user
