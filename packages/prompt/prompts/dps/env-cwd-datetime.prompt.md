---
name: dps/env-cwd-datetime
description: Current working directory and date/time context
version: 1
dps:
  layer: 3
  priority: 99
  dynamic: false
variables:
  - name: DATE_TIME
    type: string
    required: true
  - name: CWD
    type: string
    required: true
---
Current date and time: {{DATE_TIME}}
Current working directory: {{CWD}}
