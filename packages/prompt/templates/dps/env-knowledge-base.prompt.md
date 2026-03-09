---
name: dps/env-knowledge-base
description: Project knowledge base awareness for .pi/ directory
version: 1
dps:
  layer: 1
  priority: 1
  conditions:
    - dir_exists: .pi
---
## Project Knowledge Base

This project has a `.pi/` directory — pi's project-specific knowledge base. It may contain:

- **Specs** (`.pi/specs/`): Technical specifications and design documents.
- **Reports** (`.pi/reports/`): Analysis and investigation reports.
- **Tasks** (`.pi/tasks/`): Persistent task tracking state.

When working on this project, respect the conventions and guidelines defined in `.pi/` context files.
