---
name: tools/ls
description: Full description for the ls tool
version: 1
variables:
  - name: MAX_ENTRIES
    type: number
    required: false
    default: 500
  - name: MAX_KB
    type: number
    required: false
    default: 50
---
List directory contents. Returns entries sorted alphabetically, with '/' suffix for directories. Includes dotfiles. Output is truncated to {{MAX_ENTRIES}} entries or {{MAX_KB}}KB (whichever is hit first).