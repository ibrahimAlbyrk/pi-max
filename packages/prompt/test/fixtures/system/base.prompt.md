---
name: system/base
description: Base system prompt
version: 1
variables:
  - name: AGENT_NAME
    type: string
    required: true
  - name: VERBOSE
    type: boolean
    required: false
    default: false
---
You are {{AGENT_NAME}}, an AI assistant.

{{#if VERBOSE}}
You should provide detailed explanations.
{{/if}}