---
name: tools/webfetch
description: Full description for the webfetch tool
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
Fetch a web page and return its content as clean markdown. Strips navigation, ads, and boilerplate. Supports CSS selectors to extract specific sections. Output is truncated to {{MAX_LINES}} lines or {{MAX_KB}}KB (whichever is hit first).