---
name: tools/grep
description: Full description for the grep tool
version: 1
variables:
  - name: MAX_MATCHES
    type: number
    required: false
    default: 100
  - name: MAX_KB
    type: number
    required: false
    default: 50
  - name: MAX_LINE_LENGTH
    type: number
    required: false
    default: 500
---
Search file contents for a pattern. Returns matching lines with file paths and line numbers. Respects .gitignore. Output is truncated to {{MAX_MATCHES}} matches or {{MAX_KB}}KB (whichever is hit first). Long lines are truncated to {{MAX_LINE_LENGTH}} chars.