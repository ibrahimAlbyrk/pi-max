---
name: dps/env-skills
description: Available skills for specialized tasks
version: 1
dps:
  layer: 1
  priority: 10
  conditions:
    - tool_active: read
    - has_skills: true
variables:
  - name: SKILLS_SECTION
    type: string
    required: false
    default: ""
---
# SKILLS
The following skills provide specialized instructions for specific tasks.
Use the read tool to load a skill's file when the task matches its description.
When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.

{{SKILLS_SECTION}}
