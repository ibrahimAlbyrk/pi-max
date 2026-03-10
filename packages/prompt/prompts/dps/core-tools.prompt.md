---
name: dps/core-tools
description: Active tool list with descriptions
version: 1
dps:
  layer: 0
  priority: 10
variables:
  - name: TOOLS_LIST
    type: string
    required: true
---
Available tools:
{{TOOLS_LIST}}
