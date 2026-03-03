---
name: tools/find
description: Full description for the find tool
version: 1
variables:
  - name: MAX_RESULTS
    type: number
    required: false
    default: 1000
  - name: MAX_KB
    type: number
    required: false
    default: 50
---
Search for files by glob pattern. Returns matching file paths relative to the search directory. Respects .gitignore. Output is truncated to {{MAX_RESULTS}} results or {{MAX_KB}}KB (whichever is hit first).