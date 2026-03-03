# @mariozechner/pi-prompt

Centralized prompt management system for the pi monorepo.

## Features

- **Template rendering**: `{{VAR}}` variable replacement with conditional logic (`{{#if}}`, `{{#unless}}`, `{{#each}}`)
- **Inheritance**: `extends` for single-parent prompt inheritance
- **Composition**: `includes` and `{{> partial}}` for reusable prompt fragments
- **Caching**: In-memory cache with invalidation support
- **Validation**: Detect missing variables, broken references, circular dependencies

## Usage

```typescript
import { createPromptRegistry } from "@mariozechner/pi-prompt"

const prompts = createPromptRegistry({
  templatesDir: "./templates"
})

// Render a prompt with variables
const result = prompts.render("system/coding-agent", {
  WORKING_DIR: process.cwd(),
  DATE_TIME: new Date().toLocaleString(),
  HAS_SKILLS: true,
  SKILLS: "..."
})

// Get metadata without rendering
const meta = prompts.getMeta("tools/read")

// List all prompts
const all = prompts.list()

// Validate all prompts
const issues = prompts.validate()
```

## Prompt File Format

Files use `.prompt.md` extension with YAML frontmatter:

```markdown
---
name: my-prompt
description: What this prompt does
version: 1
extends: base-system
includes:
  - shared/safety-rules
variables:
  - name: USER_NAME
    type: string
    required: true
  - name: VERBOSE
    type: boolean
    required: false
    default: false
---

Hello {{USER_NAME}}.

{{#if VERBOSE}}
Here is detailed information...
{{/if}}

{{> shared/safety-rules}}
```

## Template Syntax

| Syntax | Description |
|--------|-------------|
| `{{VAR}}` | Variable replacement |
| `{{#if VAR}}...{{/if}}` | Truthy conditional |
| `{{#if VAR == "val"}}...{{/if}}` | Equality check |
| `{{#if VAR != "val"}}...{{/if}}` | Inequality check |
| `{{#unless VAR}}...{{/unless}}` | Falsy conditional |
| `{{#each ARR as item}}...{{/each}}` | Array iteration |
| `{{else if COND}}` | Chained condition |
| `{{else}}` | Default branch |
| `{{> partial-name}}` | Include partial |
