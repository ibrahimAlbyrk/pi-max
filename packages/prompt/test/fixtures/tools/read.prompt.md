---
name: tools/read
description: Read tool description
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
Read the contents of a file. Output is truncated to {{MAX_LINES}} lines or {{MAX_KB}}KB.