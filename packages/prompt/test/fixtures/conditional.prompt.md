---
name: conditional
description: Test prompt for conditional logic
version: 1
variables:
  - name: MODE
    type: string
    required: true
  - name: HAS_TOOLS
    type: boolean
    required: false
    default: false
  - name: TOOLS
    type: object[]
    required: false
    default: []
  - name: IS_READONLY
    type: boolean
    required: false
    default: false
---
{{#if MODE == "verbose"}}
Detailed mode active.
{{else if MODE == "concise"}}
Concise mode.
{{else}}
Normal mode.
{{/if}}

{{#if HAS_TOOLS}}
Tools:
{{#each TOOLS as tool}}
- {{tool.name}}: {{tool.description}}
{{/each}}
{{/if}}

{{#unless IS_READONLY}}
You can write files.
{{/unless}}