> pi can create prompt templates. Ask it to build one for your workflow.

# Prompt Templates

Prompt templates are Markdown snippets that expand into full prompts. Type `/name` in the editor to invoke a template, where `name` is the filename without `.md`.

## Locations

Pi loads prompt templates from:

- Global: `~/.pi/agent/prompts/*.md`
- Project: `.pi/prompts/*.md`
- Packages: `prompts/` directories or `pi.prompts` entries in `package.json`
- Settings: `prompts` array with files or directories
- CLI: `--prompt-template <path>` (repeatable)

Disable discovery with `--no-prompt-templates`.

## Format

```markdown
---
description: Review staged git changes
---
Review the staged changes (`git diff --cached`). Focus on:
- Bugs and logic errors
- Security issues
- Error handling gaps
```

- The filename becomes the command name. `review.md` becomes `/review`.
- `description` is optional. If missing, the first non-empty line is used.

## Usage

Type `/` followed by the template name in the editor. Autocomplete shows available templates with descriptions.

```
/review                           # Expands review.md
/component Button                 # Expands with argument
/component Button "click handler" # Multiple arguments
```

## Arguments

Templates support positional arguments and simple slicing:

- `$1`, `$2`, ... positional args
- `$@` or `$ARGUMENTS` for all args joined
- `${@:N}` for args from the Nth position (1-indexed)
- `${@:N:L}` for `L` args starting at N

Example:

```markdown
---
description: Create a component
---
Create a React component named $1 with features: $@
```

Usage: `/component Button "onClick handler" "disabled support"`

## Nested Directories

Template discovery in `prompts/` is recursive. Subdirectory names become part of the command using `:` as separator.

```
prompts/
  review.md          → /review
  git/
    commit.md        → /git:commit
    hooks/
      pre-push.md    → /git:hooks:pre-push
```

Usage:

```
/git:commit              # Expands prompts/git/commit.md
/git:hooks:pre-push      # Expands prompts/git/hooks/pre-push.md
```

## Loading Rules

- Template discovery in `prompts/` is recursive — subdirectories are automatically scanned.
- Nested templates use `:` as a path separator in their command names.
