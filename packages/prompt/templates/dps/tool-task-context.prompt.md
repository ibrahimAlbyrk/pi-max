---
name: dps/tool-task-context
description: Current task management state and context
version: 1
dps:
  layer: 2
  priority: 1
  dynamic: true
  conditions:
    - tool_active: task
variables:
  - name: TASK_CONTEXT
    type: string
    required: false
    default: ""
---
{{TASK_CONTEXT}}
