# Resource Watcher

## Overview

The Resource Watcher (`ResourceWatcher`) monitors resource directories for file changes and triggers targeted reloads — no restart or `/reload` required. Changes are debounced per resource type and applied automatically.

Currently watches: **skills** and **prompts**.

The system is designed to be resource-type agnostic. Adding a new watched type requires ~10 lines across 3 files.

---

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│  InteractiveMode                                         │
│    setupResourceWatcher()     → creates watcher + bus    │
│    handleResourceChange()     → queues if streaming      │
│    applyResourceChange()      → reload + autocomplete    │
│    flushPendingResourceReloads() → after agent_end       │
└──────────────────────┬───────────────────────────────────┘
                       │ EventBus("resource_changed")
┌──────────────────────┴───────────────────────────────────┐
│  ResourceWatcher                                         │
│    fs.watch() per directory (kernel-level, near-zero CPU)│
│    debounce per resource type (300ms default)            │
│    emits ResourceChangeEvent on EventBus                 │
└──────────────────────┬───────────────────────────────────┘
                       │ WatchPathConfig[]
┌──────────────────────┴───────────────────────────────────┐
│  DefaultResourceLoader                                   │
│    getWatchPaths(types)  → directories to watch          │
│    reloadSkills()        → re-scan skill paths + defaults│
│    reloadPrompts()       → re-scan prompt paths + defaults│
└──────────────────────────────────────────────────────────┘
```

### Key Files

| File | Role |
|------|------|
| `src/core/resource-watcher.ts` | `ResourceWatcher` class, types, EventBus channel |
| `src/core/resource-loader.ts` | `getWatchPaths()`, `reloadSkills()`, `reloadPrompts()` |
| `src/core/settings-manager.ts` | `WatchSettings`, getters for watch config |
| `src/modes/interactive/interactive-mode.ts` | Watcher lifecycle, change handlers, flush logic |

---

## Watched Paths

### Skills
- `~/.pi/agent/skills/` (global, recursive, `*.md`)
- `.pi/skills/` (project, recursive, `*.md`)
- Any directories in `lastSkillPaths` (from packages, settings, CLI flags)

### Prompts
- `~/.pi/agent/prompts/` (global, recursive, `*.md`)
- `.pi/prompts/` (project, recursive, `*.md`)
- Any directories in `lastPromptPaths` (from packages, settings, CLI flags)

Paths that don't exist at startup are skipped. After `/reload`, paths are reconciled (new ones added, stale ones removed).

---

## Configuration

In `settings.json` (global or project):

```jsonc
{
  "watch": {
    "enabled": true,              // master toggle (default: true)
    "debounceMs": 300,            // debounce interval in ms (default: 300)
    "resourceTypes": ["skill", "prompt"]  // which types to watch (default: ["skill", "prompt"])
  }
}
```

### Disabling

```jsonc
{ "watch": { "enabled": false } }
```

### Watching only skills (not prompts)

```jsonc
{ "watch": { "resourceTypes": ["skill"] } }
```

---

## Lifecycle

```
pi startup
  → init()
    → setupResourceWatcher()
      → creates dedicated EventBus
      → creates ResourceWatcher(eventBus, debounceMs)
      → resourceLoader.getWatchPaths(types) → WatchPathConfig[]
      → watcher.watch(configs) → fs.watch per directory
      → eventBus.on("resource_changed", handleResourceChange)

file changes on disk
  → fs.watch fires callback
  → ResourceWatcher debounces (300ms per type)
  → eventBus.emit("resource_changed", { type, changes })
  → handleResourceChange()
    → if streaming/compacting → queue in pendingResourceReloads
    → else → applyResourceChange(type)

applyResourceChange("skill")
  → resourceLoader.reloadSkills()
  → setupAutocomplete()
  → if metadata changed → session.rebuildSystemPrompt()
  → showStatus("Skills updated")

applyResourceChange("prompt")
  → resourceLoader.reloadPrompts()
  → setupAutocomplete()
  → showStatus("Prompts updated")

agent_end / auto_compaction_end
  → flushPendingResourceReloads()
  → applies all queued changes

/reload (manual)
  → full session.reload()
  → watcher.reconcile(newPaths)

pi shutdown
  → stop()
    → watcher.dispose() → closes all fs.watch handles
    → unsubscribe from EventBus
```

---

## Adding a New Watched Resource Type

Three changes required (~10 lines total):

### Step 1: Add to `WatchableResourceType`

**File**: `src/core/resource-watcher.ts`

```typescript
export type WatchableResourceType = "skill" | "prompt" | "theme" | "extension" | "context";
//                                                         ^^^^^
//                                          already declared, just use it
```

If the type doesn't exist yet, add it to the union.

### Step 2: Add watch paths in `getWatchPaths()`

**File**: `src/core/resource-loader.ts`, inside `getWatchPaths()` method

```typescript
if (typeSet.has("theme")) {
  const defaultThemeDirs = [
    join(this.agentDir, "themes"),
    join(this.cwd, CONFIG_DIR_NAME, "themes"),
  ];
  for (const dir of defaultThemeDirs) {
    if (existsSync(dir)) {
      configs.push({
        path: dir,
        resourceType: "theme",
        recursive: false,       // themes are flat .json files
        extensionFilter: ".json",
      });
    }
  }
}
```

Also add a `reloadThemes()` method if one doesn't exist:

```typescript
reloadThemes(): void {
  const defaultThemeDirs = [
    join(this.agentDir, "themes"),
    join(this.cwd, CONFIG_DIR_NAME, "themes"),
  ];
  const allPaths = this.mergePaths(this.lastThemePaths, defaultThemeDirs);
  this.updateThemesFromPaths(allPaths);
}
```

And add `reloadThemes()` to the `ResourceLoader` interface.

### Step 3: Add handler in `applyResourceChange()`

**File**: `src/modes/interactive/interactive-mode.ts`, inside `applyResourceChange()` method

```typescript
case "theme": {
  this.session.resourceLoader.reloadThemes();
  setRegisteredThemes(this.session.resourceLoader.getThemes().themes);
  const themeName = this.settingsManager.getTheme();
  if (themeName) setTheme(themeName, true);
  this.showStatus("Themes updated");
  break;
}
```

### Step 4: Enable in settings (optional)

Add to the default watched types:

```jsonc
{ "watch": { "resourceTypes": ["skill", "prompt", "theme"] } }
```

Or change the default in `settings-manager.ts`:

```typescript
getWatchResourceTypes(): string[] {
  return this.settings.watch?.resourceTypes ?? ["skill", "prompt", "theme"];
}
```

---

## Streaming & Compaction Safety

Changes that arrive while the agent is streaming or compacting are **not applied immediately**. They are queued in `pendingResourceReloads` (a `Set<WatchableResourceType>`) and flushed when:

- `agent_end` event fires (streaming complete)
- `auto_compaction_end` event fires (compaction complete)

This prevents race conditions between resource reload and active agent processing.

Multiple changes of the same type during streaming are collapsed into a single reload (Set deduplication).

---

## Debounce Behavior

Changes are debounced **per resource type**, not globally. This means:

- A skill file change starts a 300ms timer for `"skill"`
- A prompt file change starts an independent 300ms timer for `"prompt"`
- If another skill file changes within 300ms, the timer resets
- When the timer fires, all accumulated changes for that type are emitted as one event

This handles batch operations (e.g., `git checkout` affecting multiple files) efficiently.

---

## System Prompt Rebuild

System prompt is rebuilt only when **skill metadata changes** (add/remove/rename/description change). Content-only edits to a skill file do NOT trigger a rebuild because:

1. Skill content is read lazily at `/skill:name` invocation time
2. System prompt only contains skill name + description + location
3. Rebuilding mid-conversation changes the context window

The `skillMetadataChanged()` helper compares old vs new skill lists by name and description.

---

## Limitations

- **Directories must exist at watch setup time.** If `.pi/skills/` is created after pi starts, it won't be watched until `/reload`.
- **Package resources (`node_modules`) are not watched.** Package changes require `/reload`.
- **`fs.watch` recursive mode** requires macOS, Windows, or Linux with Node 19+. On older Linux, only top-level changes are detected.
- **No file-level validation on change.** A malformed YAML frontmatter in a skill file will produce a diagnostic warning but won't crash.
