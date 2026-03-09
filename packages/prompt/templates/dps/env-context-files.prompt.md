---
name: dps/env-context-files
description: Project context files from .pi/ directory
version: 1
dps:
  layer: 1
  priority: 11
  conditions:
    - dir_exists: .pi
variables:
  - name: CONTEXT_FILES_SECTION
    type: string
    required: false
    default: ""
---
{{CONTEXT_FILES_SECTION}}
