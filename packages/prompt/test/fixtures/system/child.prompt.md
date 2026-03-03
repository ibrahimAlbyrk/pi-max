---
name: system/child
description: Child system prompt extending base
version: 1
extends: system/base
includes:
  - shared/safety
variables:
  - name: WORKING_DIR
    type: string
    required: true
  - name: VERBOSE
    type: boolean
    required: false
    default: true
---
Current directory: {{WORKING_DIR}}

{{> shared/safety}}