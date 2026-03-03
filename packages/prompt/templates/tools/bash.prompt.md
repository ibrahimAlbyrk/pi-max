---
name: tools/bash
description: Full description for the bash tool
version: 1
variables:
  - name: MAX_LINES
    type: number
    required: false
    default: 2000
  - name: MAX_KB
    type: number
    required: false
    default: 50
---
Execute a bash command in the current working directory. Returns stdout and stderr. Output is truncated to last {{MAX_LINES}} lines or {{MAX_KB}}KB (whichever is hit first). If truncated, full output is saved to a temp file. Optionally provide a timeout in seconds.