---
name: tools/read
description: Full description for the read tool
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
Read the contents of a file. Supports text files and images (jpg, png, gif, webp). Images are sent as attachments. For text files, output is truncated to {{MAX_LINES}} lines or {{MAX_KB}}KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete.