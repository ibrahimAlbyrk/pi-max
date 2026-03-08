# Restrictions

Restrictions provide a configurable sandbox for agent tool access. When enabled, they can block filesystem access, bash commands, and specific tools before execution.

## Table of Contents

- [Configuration](#configuration)
- [Config Locations](#config-locations)
- [Config Schema](#config-schema)
- [Filesystem Restrictions](#filesystem-restrictions)
- [Bash Restrictions](#bash-restrictions)
- [Tool Restrictions](#tool-restrictions)
- [CLI Flags](#cli-flags)
- [Examples](#examples)

## Configuration

Restrictions are configured via JSON files. They are **disabled by default** — set `"enabled": true` to activate.

## Config Locations

Pi loads restrictions config from two locations (merged, project takes precedence):

1. **Global:** `~/.pi/agent/restrictions.json`
2. **Project-local:** `.pi/restrictions.json`

When both exist, they are merged on top of defaults. Project-local values override global values per section.

## Config Schema

```json
{
  "enabled": true,
  "filesystem": {
    "allowedPaths": ["."],
    "deniedPaths": ["~/.ssh", "~/.aws"],
    "deniedPatterns": ["**/.env", "**/*.pem"],
    "readOnly": false
  },
  "bash": {
    "deniedPatterns": ["sudo\\s+", "rm\\s+(-rf|--recursive)\\s+/"],
    "deniedCommands": ["npm publish"],
    "requireConfirmation": ["git push --force"],
    "timeout": 0
  },
  "tools": {
    "disabled": [],
    "readOnlyMode": false
  },
  "ui": {
    "showNotifications": true
  }
}
```

## Filesystem Restrictions

Controls which files and directories the agent can access.

| Field | Type | Description |
|-------|------|-------------|
| `allowedPaths` | `string[]` | Base paths the agent can access (relative to cwd). Default: `["."]` |
| `deniedPaths` | `string[]` | Explicitly denied paths (absolute or relative). Checked before `allowedPaths`. |
| `deniedPatterns` | `string[]` | Glob patterns for denied files (e.g., `**/.env`, `**/*.pem`). |
| `readOnly` | `boolean` | Block all write/edit operations. Default: `false` |

**Evaluation order:**
1. Denied paths (highest priority — always blocked)
2. Denied patterns (blocked if matched)
3. Allowed paths (blocked if outside)

### Glob Patterns

Supported syntax in `deniedPatterns`:
- `**` — matches any path depth
- `*` — matches any filename characters (not `/`)
- `?` — matches a single character (not `/`)

Examples:
- `**/.env` — blocks all `.env` files in any directory
- `**/*.pem` — blocks all `.pem` files
- `**/secrets/*` — blocks everything under any `secrets/` directory

### Path Resolution

- Paths starting with `~/` are expanded to the home directory
- Relative paths are resolved against the working directory
- Leading `@` is stripped (some models add it)

## Bash Restrictions

Controls which bash commands the agent can execute.

| Field | Type | Description |
|-------|------|-------------|
| `deniedPatterns` | `string[]` | Regex patterns. If any matches, the command is blocked. Case-insensitive. |
| `deniedCommands` | `string[]` | Literal substrings. If the command contains any, it is blocked. |
| `requireConfirmation` | `string[]` | Literal substrings. If the command contains any, the user must confirm before execution. |
| `timeout` | `number` | Max timeout in seconds. `0` = no limit. |

### Denied Patterns (Regex)

Patterns are evaluated as case-insensitive regular expressions:

```json
{
  "bash": {
    "deniedPatterns": [
      "sudo\\s+",
      "rm\\s+(-rf|--recursive)\\s+/",
      "chmod\\s+777"
    ]
  }
}
```

### Confirmation

Commands matching `requireConfirmation` patterns prompt the user before execution. If no UI is available (e.g., non-interactive mode), the command is blocked.

```json
{
  "bash": {
    "requireConfirmation": [
      "git push --force",
      "npm publish",
      "docker rm"
    ]
  }
}
```

## Tool Restrictions

Controls which tools are available to the agent.

| Field | Type | Description |
|-------|------|-------------|
| `disabled` | `string[]` | Tool names to disable entirely (e.g., `["bash", "write"]`). |
| `readOnlyMode` | `boolean` | Disables `write`, `edit`, and `bash` tools. Default: `false` |

```json
{
  "tools": {
    "disabled": ["bash"],
    "readOnlyMode": false
  }
}
```

## CLI Flags

| Flag | Description |
|------|-------------|
| `--no-restrictions` | Disable all restrictions for the session |

## Examples

### Read-only agent (no file modifications)

```json
{
  "enabled": true,
  "filesystem": {
    "readOnly": true
  }
}
```

### Block sensitive files and dangerous commands

```json
{
  "enabled": true,
  "filesystem": {
    "allowedPaths": ["."],
    "deniedPaths": ["~/.ssh", "~/.aws", "~/.gnupg"],
    "deniedPatterns": ["**/.env", "**/.env.*", "**/*.pem", "**/*.key", "**/secrets/*"]
  },
  "bash": {
    "deniedPatterns": ["sudo\\s+", "rm\\s+(-rf|--recursive)\\s+/"],
    "requireConfirmation": ["git push --force", "npm publish"]
  }
}
```

### Restrict to specific directory only

```json
{
  "enabled": true,
  "filesystem": {
    "allowedPaths": ["src/", "tests/"]
  }
}
```

### Disable specific tools

```json
{
  "enabled": true,
  "tools": {
    "disabled": ["bash", "write"]
  }
}
```
