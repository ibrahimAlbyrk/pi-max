---
name: dps/core-pi-docs
description: Pi documentation references for pi-specific development
version: 1
dps:
  layer: 0
  priority: 2
variables:
  - name: README_PATH
    type: string
    required: true
  - name: DOCS_PATH
    type: string
    required: true
  - name: EXAMPLES_PATH
    type: string
    required: true
---
Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):
- Main documentation: {{README_PATH}}
- Additional docs: {{DOCS_PATH}}
- Examples: {{EXAMPLES_PATH}} (extensions, custom tools, SDK)
- When asked about: extensions (docs/extensions.md, examples/extensions/), themes (docs/themes.md), skills (docs/skills.md), prompt templates (docs/prompt-templates.md), TUI components (docs/tui.md), keybindings (docs/keybindings.md), SDK integrations (docs/sdk.md), custom providers (docs/custom-provider.md), adding models (docs/models.md), pi packages (docs/packages.md)
- When working on pi topics, read the docs and examples, and follow .md cross-references before implementing
- Always read pi .md files completely and follow links to related docs (e.g., tui.md for TUI API details)
