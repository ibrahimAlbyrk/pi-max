# Built-in Background Process Feature — Implementation Spec

**Status:** Draft
**Migrating from:** `.pi/extensions/background-process/` (3 files, ~1,631 LOC)
**Target location:** `packages/coding-agent/src/core/tools/bg.ts` + `packages/coding-agent/src/core/features/bg/`
**Related report:** [extensions-to-builtin.report.md](../reports/extensions-to-builtin.report.md)

---

## 1. Overview

The background process feature allows the LLM agent to start, stop, monitor, and restart long-running processes (dev servers, watchers, build tools, etc.) without blocking the conversation. It provides:

1. **`bg` tool** — LLM-callable tool with 5 actions: run, stop, list, logs, restart
2. **ProcessManager** — Singleton process lifecycle manager with RingBuffer output capture
3. **TUI components** — Interactive ProcessPanel overlay + animated editor badge
4. **Lifecycle hooks** — Session shutdown cleanup, task completion auto-stop
5. **Slash command** — `/bg` for manual process management
6. **Keyboard shortcut** — `shift+down` to open ProcessPanel

---

## 2. Architecture

### 2.1 File Structure

```
packages/coding-agent/src/
├── core/
│   ├── tools/
│   │   ├── bg.ts                    # Tool factory + parameter schema
│   │   └── index.ts                 # Updated: add bg to _toolRegistry
│   └── features/
│       └── bg/
│           ├── index.ts             # Feature entry: exports setup function
│           ├── manager.ts           # BackgroundProcessManager class
│           ├── ring-buffer.ts       # RingBuffer circular buffer
│           ├── panel.ts            # ProcessPanel TUI component (Focusable)
│           └── badge.ts            # Editor badge animation logic
```

### 2.2 Integration Points

```
AgentSession constructor
    │
    ├─ _customTools.push(bgToolDefinition)     # Tool registration (like ask_user)
    │
    ├─ bgFeature.setup(session)                # Hook registration
    │   ├─ session_shutdown → manager.stopAll()
    │   └─ task:completed → manager.stopByTaskId()
    │
    └─ Interactive mode
        ├─ /bg command registration
        ├─ shift+down shortcut registration
        └─ Editor badge rendering
```

### 2.3 Registration Strategy

The `bg` tool will follow the **`ask_user` pattern** — registered as a `ToolDefinition` (not a plain `AgentTool`) and added to `_customTools` in `AgentSession`. This is necessary because:

- The tool needs `ExtensionContext` (specifically `ctx.cwd` for process working directory)
- Custom `renderCall` and `renderResult` for TUI display
- Access to the ProcessManager singleton via closure

Additionally, it must **also** be added to `_toolRegistry` in `tools/index.ts` so that subagents can instantiate it via `--tools bg`. This requires a factory function pattern:

```typescript
// tools/index.ts
const _toolRegistry = {
  // ... existing tools ...
  bg: (cwd: string) => createBgTool(cwd),
};
```

The `createBgTool(cwd)` factory returns a plain `AgentTool` (no ExtensionContext needed for subagents — they get cwd from the factory parameter). The main agent uses the `ToolDefinition` version with `renderCall`/`renderResult`.

---

## 3. Component Specifications

### 3.1 ProcessManager (`features/bg/manager.ts`)

Singleton per-process. Manages spawned child processes.

```typescript
export type ProcessStatus = "running" | "stopped" | "crashed";

export interface ManagedProcess {
  name: string;
  command: string;
  pid: number;
  status: ProcessStatus;
  exitCode: number | null;
  startedAt: number;
  stoppedAt: number | null;
  cwd: string;
  buffer: RingBuffer;
  child: ChildProcess;
  linkedTaskId?: number;
}

export interface ProcessInfo {
  name: string;
  command: string;
  pid: number;
  status: ProcessStatus;
  exitCode: number | null;
  startedAt: number;
  stoppedAt: number | null;
  uptime: string;
  lastOutput: string;
  linkedTaskId?: number;
}

export class BackgroundProcessManager {
  private processes: Map<string, ManagedProcess> = new Map();
  private onChangeCallbacks: Set<() => void> = new Set();

  // --- Core Operations ---

  run(opts: {
    command: string;
    name?: string;
    cwd: string;
    env?: Record<string, string>;
    linkedTaskId?: number;
  }): { name: string; pid: number } | { error: string };

  async stop(name: string): Promise<{ success: boolean; error?: string }>;
  // SIGTERM → 5 second grace → SIGKILL

  async restart(name: string): Promise<{ name: string; pid: number } | { error: string }>;
  // Saves command/cwd/taskId, stops, removes, re-runs

  logs(name: string, lines?: number): { lines: string[] } | { error: string };
  // Default: 50 lines from RingBuffer

  list(): ProcessInfo[];
  // All processes with formatted uptime

  // --- Lifecycle ---

  async stopAll(): Promise<void>;
  // Stops all running processes (called on session shutdown)

  remove(name: string): boolean;
  // SIGKILL + delete from map

  cleanup(): number;
  // Remove all non-running processes, return count removed

  // --- Lookup ---

  get(name: string): ManagedProcess | undefined;
  getByTaskId(taskId: number): ManagedProcess | undefined;

  // --- State ---

  get size(): number;
  get runningCount(): number;

  // --- Change notification ---

  onChange(callback: () => void): () => void;
  // Returns unsubscribe function. Called on any process state change.

  // --- Internal ---

  private deriveName(command: string): string;
  // "npm run dev" → "npm-run-dev", deduplicates with -2, -3 suffix

  private formatUptime(proc: ManagedProcess): string;
  // "1h 5m", "23m 4s", or "12s"
}
```

**Process spawning details:**
- Uses `child_process.spawn(command, { shell: true, stdio: ["ignore", "pipe", "pipe"] })`
- stdout and stderr both piped to the same RingBuffer
- Exit handler sets status to `"stopped"` (signals SIGTERM/SIGKILL) or `"crashed"` (other)
- Error handler (spawn failure) sets status to `"crashed"`

**Singleton pattern:**
```typescript
// Per-process singleton
let _manager: BackgroundProcessManager | null = null;

export function getProcessManager(): BackgroundProcessManager {
  if (!_manager) {
    _manager = new BackgroundProcessManager();
  }
  return _manager;
}

export function disposeProcessManager(): void {
  if (_manager) {
    // stopAll is async but we fire-and-forget during process exit
    _manager.stopAll();
    _manager = null;
  }
}
```

### 3.2 RingBuffer (`features/bg/ring-buffer.ts`)

Circular buffer for bounded output capture.

```typescript
export class RingBuffer {
  private buffer: string[];
  private head: number = 0;
  private count: number = 0;

  constructor(private capacity: number = 500);

  push(text: string): void;
  // Splits by newline, pushes each line, wraps around at capacity

  getLines(n?: number): string[];
  // Returns last n lines (default: all). Handles wrap-around.

  get size(): number;
  clear(): void;
}
```

### 3.3 Tool Definition (`tools/bg.ts`)

Two exports: a `ToolDefinition` (for main agent with renderCall/renderResult) and a factory `createBgTool` (for subagents via tool registry).

```typescript
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { ToolDefinition } from "../extensions/types.js";
import { getProcessManager } from "../features/bg/index.js";

// --- Parameter Schema ---

const bgSchema = Type.Object({
  action: StringEnum(["run", "stop", "list", "logs", "restart"] as const),
  command: Type.Optional(Type.String({
    description: "Shell command to run (for 'run' action)"
  })),
  name: Type.Optional(Type.String({
    description: "Process name/identifier. Auto-derived from command if not provided."
  })),
  cwd: Type.Optional(Type.String({
    description: "Working directory for the process"
  })),
  lines: Type.Optional(Type.Number({
    description: "Number of log lines to retrieve (default: 50)"
  })),
  taskId: Type.Optional(Type.Number({
    description: "Link this process to a task ID"
  })),
});

export type BgToolInput = Static<typeof bgSchema>;

export interface BgToolDetails {
  action: string;
  processName?: string;
  pid?: number;
}

// --- Tool Definition (for main agent — includes renderCall/renderResult) ---

export const bgToolDefinition: ToolDefinition<typeof bgSchema, BgToolDetails> = {
  name: "bg",
  label: "Background Process",
  description: "Manage background processes (servers, watchers, long-running tasks).\n\nActions:\n- **run**: Start a command in the background...",
  parameters: bgSchema,

  async execute(toolCallId, params, signal, onUpdate, ctx) {
    const manager = getProcessManager();
    const cwd = params.cwd || ctx.cwd;

    switch (params.action) {
      case "run": { /* ... */ }
      case "stop": { /* ... */ }
      case "list": { /* ... */ }
      case "logs": { /* ... */ }
      case "restart": { /* ... */ }
    }
  },

  renderCall(args, options, theme) {
    // Render: "bg run npm run dev" or "bg stop devserver" etc.
  },

  renderResult(result, options, theme) {
    // Render process info, log output, list table
  },
};

// --- Factory (for subagents via tool registry — plain AgentTool) ---

export function createBgTool(cwd: string): AgentTool<typeof bgSchema> {
  const manager = getProcessManager();

  return {
    name: "bg",
    label: "bg",
    sideEffects: true,
    description: bgToolDefinition.description,
    parameters: bgSchema,
    async execute(toolCallId, params, signal, onUpdate) {
      // Same logic as bgToolDefinition.execute but uses factory cwd
      // instead of ctx.cwd (no ExtensionContext available)
      const effectiveCwd = params.cwd || cwd;
      // ... dispatch to manager ...
    },
  };
}
```

### 3.4 Tool Registration in tools/index.ts

```typescript
// Add to _toolRegistry
const _toolRegistry = {
  read: (cwd: string) => createReadTool(cwd),
  bash: (cwd: string) => createBashTool(cwd),
  edit: (cwd: string) => createEditTool(cwd),
  write: (cwd: string) => createWriteTool(cwd),
  search: (cwd: string) => createSearchTool(cwd),
  webfetch: (_cwd: string) => createWebfetchTool(),
  websearch: (_cwd: string) => createWebsearchTool(),
  bg: (cwd: string) => createBgTool(cwd),           // NEW
};
```

### 3.5 Tool Registration in AgentSession

Following the `ask_user` pattern, the `bgToolDefinition` is added to `_customTools`:

```typescript
// In AgentSession constructor (agent-session.ts)
this._customTools = [
  ...(config.customTools ?? []),
  askUserTool as unknown as ToolDefinition,
  bgToolDefinition as unknown as ToolDefinition,  // NEW
];
```

This means:
- Main agent gets the `ToolDefinition` version with `renderCall`/`renderResult` + `ExtensionContext`
- Subagents get the `createBgTool(cwd)` factory version via `--tools bg`
- Both share the same `ProcessManager` singleton (within their process)

### 3.6 Feature Setup (`features/bg/index.ts`)

```typescript
import type { AgentSession } from "../agent-session.js";
import { getProcessManager, disposeProcessManager } from "./manager.js";

export { getProcessManager, disposeProcessManager } from "./manager.js";
export { BackgroundProcessManager } from "./manager.js";
export { RingBuffer } from "./ring-buffer.js";

/**
 * Setup background process feature hooks.
 * Called from AgentSession initialization.
 */
export function setupBgFeature(session: AgentSession): void {
  const manager = getProcessManager();

  // 1. Session shutdown → stop all processes
  // This replaces the extension's pi.on("session_shutdown", ...)
  session.onSessionShutdown(async () => {
    await manager.stopAll();
  });

  // 2. Task completion → auto-stop linked processes
  // This replaces the extension's pi.events.on("task:completed", ...)
  session.onEvent("task:completed", async (data: any) => {
    const task = data?.task;
    if (!task?.id) return;
    const proc = manager.getByTaskId(task.id);
    if (proc && proc.status === "running") {
      await manager.stop(proc.name);
    }
  });
}
```

**Note:** The `session.onSessionShutdown()` and `session.onEvent()` methods may not exist yet. See Section 5.1 for required agent-session changes.

### 3.7 ProcessPanel TUI Component (`features/bg/panel.ts`)

Interactive overlay showing all processes. Implements `Focusable` interface.

```typescript
import type { Focusable } from "@mariozechner/pi-tui";
import type { BackgroundProcessManager } from "./manager.js";

export interface ProcessPanelResult {
  action: "stop" | "restart" | "kill" | "stopall" | "killall";
  name?: string;
}

export class ProcessPanel implements Focusable {
  focused: boolean = false;
  private selectedIndex: number = 0;
  private expandedIndex: number = -1;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private cachedLines?: string[];
  private cachedWidth?: number;

  constructor(private manager: BackgroundProcessManager) {}

  // --- Focusable interface ---

  handleInput(key: Key): boolean;
  // Keyboard handling:
  //   escape/ctrl+c/shift+up → close panel (or collapse if expanded)
  //   up/down → navigate process list
  //   enter → toggle expand/collapse detail view
  //   s/S → stop selected process
  //   k/K → kill & remove selected process
  //   r/R → restart selected process

  render(width: number): string[];
  // Renders:
  //   ┌─ ⚙ Background Processes ─┐
  //   Running: 2, Crashed: 1
  //   ❯ ▶ devserver    running  5m 23s  ▸
  //     ✗ watcher      crashed  --      ▸
  //     ■ build        stopped  --      ▸
  //     ■ Stop All
  //   ↑↓ navigate  ↵ detail  s stop  k kill  r restart  esc close

  // Expanded detail (LOG_LINES=5):
  //   ❯ ▶ devserver    running  5m 23s  ▾
  //       Command: npm run dev
  //       PID: 12345  Task: #3
  //       ──logs──
  //       [last 5 lines of output]

  // --- Lifecycle ---

  startAutoRefresh(requestRender: () => void): void;
  // setInterval(1000ms) to update uptime display

  stopAutoRefresh(): void;
  // clearInterval

  dispose(): void;
}
```

**Panel display function:**

```typescript
export async function showProcessPanel(
  manager: BackgroundProcessManager,
  ctx: ExtensionContext,
): Promise<ProcessPanelResult | null> {
  const panel = new ProcessPanel(manager);
  const result = await ctx.ui.custom(panel);
  panel.dispose();

  if (result) {
    // Execute the action
    switch (result.action) {
      case "stop": await manager.stop(result.name!); break;
      case "kill": manager.remove(result.name!); break;
      case "restart": await manager.restart(result.name!); break;
      case "stopall": await manager.stopAll(); break;
    }
  }

  return result;
}
```

### 3.8 Editor Badge (`features/bg/badge.ts`)

Animated badge showing running process count on the editor border.

```typescript
const SHINE_INTERVAL = 120; // ms per frame
const SHINE_PAUSE_FRAMES = 12;
const BADGE_KEY = "bg-count";

export class BgBadge {
  private timer: ReturnType<typeof setInterval> | null = null;
  private frame: number = 0;
  private lastCount: number = 0;

  constructor(
    private manager: BackgroundProcessManager,
    private setEditorBadge: (key: string, content: string | undefined) => void,
    private theme: Theme,
  ) {}

  start(): void {
    // Subscribe to manager.onChange() → update badge
    this.manager.onChange(() => this.update());
    this.update();
  }

  private update(): void {
    const count = this.manager.runningCount;

    if (count === 0) {
      this.stopAnimation();
      this.setEditorBadge(BADGE_KEY, undefined);
      return;
    }

    if (count !== this.lastCount) {
      this.lastCount = count;
      this.startAnimation();
    }
  }

  private startAnimation(): void {
    if (this.timer) return;
    this.frame = 0;
    this.timer = setInterval(() => this.renderFrame(), SHINE_INTERVAL);
  }

  private stopAnimation(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private renderFrame(): void {
    const text = `⚙ bg ${this.lastCount}`;
    // Character-by-character shine sweep
    // Each frame highlights a different character position
    // After full sweep, pause for SHINE_PAUSE_FRAMES
    const totalFrames = text.length + SHINE_PAUSE_FRAMES;
    const shinePos = this.frame % totalFrames;

    let rendered = "";
    for (let i = 0; i < text.length; i++) {
      if (i === shinePos) {
        rendered += this.theme.bold(this.theme.fg("accent", text[i]));
      } else {
        rendered += this.theme.fg("muted", text[i]);
      }
    }

    this.setEditorBadge(BADGE_KEY, rendered);
    this.frame++;
  }

  dispose(): void {
    this.stopAnimation();
    this.setEditorBadge(BADGE_KEY, undefined);
  }
}
```

### 3.9 Slash Command Registration

The `/bg` command and `shift+down` shortcut must be registered. Since there's no built-in command/shortcut system outside extensions, these will be registered through one of two approaches:

**Approach A (Preferred):** Register via the extension system itself — create a minimal internal extension that uses `pi.registerCommand()` and `pi.registerShortcut()`. This avoids changing the command infrastructure.

**Approach B:** Add a built-in command registration mechanism to `AgentSession` that mirrors the extension API.

For the spec, we use **Approach A** — a thin internal extension wrapper:

```typescript
// features/bg/extension.ts
// This registers the /bg command and shift+down shortcut
// via the extension API, but lives in the source tree.

export function registerBgExtension(pi: ExtensionAPI): void {
  const manager = getProcessManager();

  pi.registerCommand("/bg", {
    description: "Background processes: /bg [stop <name>|stopall|clean]",
    getArgumentCompletions(prefix) {
      if (!prefix) return [
        { label: "stop", description: "Stop a process" },
        { label: "stopall", description: "Stop all processes" },
        { label: "clean", description: "Remove dead processes" },
      ];
      if (prefix.startsWith("stop ")) {
        const namePrefix = prefix.slice(5);
        return manager.list()
          .filter(p => p.status === "running" && p.name.startsWith(namePrefix))
          .map(p => ({ label: `stop ${p.name}`, description: p.command }));
      }
      return null;
    },
    async handler(args, ctx) {
      const trimmed = args.trim();
      if (trimmed.startsWith("stop ")) {
        const name = trimmed.slice(5).trim();
        const result = await manager.stop(name);
        ctx.ui.notify(result.success ? `Stopped ${name}` : result.error!, result.success ? "info" : "error");
      } else if (trimmed === "stopall") {
        await manager.stopAll();
        ctx.ui.notify("All processes stopped", "info");
      } else if (trimmed === "clean") {
        const count = manager.cleanup();
        ctx.ui.notify(`Cleaned ${count} dead processes`, "info");
      } else {
        await showProcessPanel(manager, ctx);
      }
    },
  });

  pi.registerShortcut("shift+down", {
    description: "Open background processes panel",
    async handler(ctx) {
      await showProcessPanel(manager, ctx);
    },
  });
}
```

---

## 4. Tool Behavior Specification

### 4.1 Action: `run`

**Required params:** `command`
**Optional params:** `name`, `cwd`, `taskId`

**Logic:**
1. Derive name from command if not provided (e.g., "npm run dev" → "npm-run-dev")
2. If name already exists and is running → return error
3. Spawn process with `shell: true`, `stdio: ["ignore", "pipe", "pipe"]`
4. Pipe stdout/stderr to RingBuffer (500 line capacity)
5. Attach exit/error handlers for status tracking
6. Return `{ name, pid }` on success

**Result format:**
```
Started "devserver" (PID 12345)
```

### 4.2 Action: `stop`

**Required params:** `name`

**Logic:**
1. Find process by name → error if not found
2. If not running → return "already stopped"
3. Send SIGTERM, wait up to 5 seconds
4. If still running after 5s → SIGKILL
5. Return success/error

**Result format:**
```
Stopped "devserver"
```

### 4.3 Action: `list`

**No required params.**

**Logic:**
1. Get all processes from manager
2. Format as table with columns: name, command (truncated), PID, status, uptime, last output line

**Result format:**
```
3 processes (2 running, 1 crashed):

Name         Command              PID    Status   Uptime    Last Output
devserver    npm run dev          12345  running  5m 23s    Server listening on :3000
watcher      npm run watch        12346  running  5m 20s    Watching for changes...
build        npm run build        --     crashed  --        Error: Cannot find module
```

### 4.4 Action: `logs`

**Required params:** `name`
**Optional params:** `lines` (default: 50)

**Logic:**
1. Find process by name → error if not found
2. Get last N lines from RingBuffer
3. Return lines joined with newline

**Result format:**
```
Last 50 lines from "devserver":

[log output...]
```

### 4.5 Action: `restart`

**Required params:** `name`

**Logic:**
1. Find process by name → error if not found
2. Save command, cwd, linkedTaskId
3. Stop process (if running)
4. Remove from map
5. Run with saved params
6. Return new `{ name, pid }`

**Result format:**
```
Restarted "devserver" (PID 12350)
```

---

## 5. Required Changes to Existing Code

### 5.1 AgentSession Changes

The following integration points need to be added or modified in `agent-session.ts`:

**a) Tool registration (constructor):**
```typescript
// Add bgToolDefinition to _customTools
import { bgToolDefinition } from "./tools/bg.js";

this._customTools = [
  ...(config.customTools ?? []),
  askUserTool as unknown as ToolDefinition,
  bgToolDefinition as unknown as ToolDefinition,
];
```

**b) Feature setup (constructor or init):**
```typescript
import { setupBgFeature } from "./features/bg/index.js";

// After _buildRuntime()
setupBgFeature(this);
```

**c) Session shutdown hook integration:**

Currently, `session_shutdown` is emitted via the ExtensionRunner. For built-in features, we need a way to register shutdown handlers without going through the extension system. Two options:

**Option 1 (Minimal change):** Add a `_builtinShutdownHandlers` array:
```typescript
private _builtinShutdownHandlers: (() => Promise<void>)[] = [];

onSessionShutdown(handler: () => Promise<void>): void {
  this._builtinShutdownHandlers.push(handler);
}

// In newSession() and reload(), before extension shutdown:
for (const handler of this._builtinShutdownHandlers) {
  await handler();
}
```

**Option 2 (Use extension system):** Register bg as an internal extension (see Section 3.9 Approach A). The extension system already handles session_shutdown.

**d) Event bus for inter-feature communication:**

For `task:completed` → auto-stop linked processes, we need the internal event bus. If the extension `pi.events` is used, bg's internal extension wrapper can subscribe:

```typescript
pi.events.on("task:completed", async (data) => { ... });
```

If built-in features need a separate event bus, add to AgentSession:
```typescript
private _featureEvents = new EventEmitter();

onEvent(event: string, handler: (...args: any[]) => void): () => void {
  this._featureEvents.on(event, handler);
  return () => this._featureEvents.off(event, handler);
}

emitEvent(event: string, ...args: any[]): void {
  this._featureEvents.emit(event, ...args);
}
```

### 5.2 tools/index.ts Changes

```diff
+ import { createBgTool } from "./bg.js";

  const _toolRegistry = {
    read: (cwd: string) => createReadTool(cwd),
    bash: (cwd: string) => createBashTool(cwd),
    edit: (cwd: string) => createEditTool(cwd),
    write: (cwd: string) => createWriteTool(cwd),
    search: (cwd: string) => createSearchTool(cwd),
    webfetch: (_cwd: string) => createWebfetchTool(),
    websearch: (_cwd: string) => createWebsearchTool(),
+   bg: (cwd: string) => createBgTool(cwd),
  };
```

### 5.3 System Prompt Description

The `bg` tool description in the system prompt (auto-generated from tool definition):

```
Manage background processes (servers, watchers, long-running tasks).

Actions:
- **run**: Start a command in the background. Returns immediately with process name and PID.
- **stop**: Stop a running process by name (SIGTERM → 5s → SIGKILL).
- **list**: Show all tracked processes with status, uptime, and last output line.
- **logs**: Get recent output (stdout+stderr) from a process.
- **restart**: Stop and re-run a process with the same command.

Examples:
  bg run "npm run dev" --name devserver
  bg run "python3 -m http.server 8080"
  bg list
  bg logs devserver --lines 100
  bg stop devserver
  bg restart devserver
```

---

## 6. Subagent Behavior

### 6.1 Isolation Model

Each subagent process gets its own `BackgroundProcessManager` singleton. When the subagent process exits:

1. Node.js process exit handler calls `disposeProcessManager()`
2. `disposeProcessManager()` calls `manager.stopAll()`
3. All child processes spawned by this subagent are terminated (SIGTERM → SIGKILL)
4. Main agent's process pool is completely unaffected

### 6.2 Subagent Tool Access

Subagents access bg via the tool registry factory:

```
pi --mode json --tools read,bash,bg "Start a dev server and check if it's running"
```

The subagent gets a `createBgTool(cwd)` instance — a plain `AgentTool` without `renderCall`/`renderResult` (no TUI in JSON mode anyway).

### 6.3 Process Exit Cleanup

Register a process exit handler to ensure cleanup:

```typescript
// In manager.ts or feature setup
process.on("exit", () => {
  const manager = getProcessManager();
  // Synchronous: send SIGKILL to all children (can't await in exit handler)
  for (const proc of manager.listRunning()) {
    try { proc.child.kill("SIGKILL"); } catch {}
  }
});

process.on("SIGTERM", () => {
  disposeProcessManager();
  process.exit(0);
});

process.on("SIGINT", () => {
  disposeProcessManager();
  process.exit(0);
});
```

---

## 7. Edge Cases and Error Handling

### 7.1 Name Conflicts
- If `run` is called with a name that already exists and is running → return error `"Process 'name' is already running"`
- If name exists but is stopped/crashed → allow reuse (overwrite entry)

### 7.2 Process Spawn Failure
- If `spawn()` throws (e.g., command not found on PATH) → catch, set status "crashed", return error

### 7.3 Orphan Processes
- On unexpected pi crash, child processes may become orphans
- The `process.on("exit")` handler sends SIGKILL as best-effort cleanup
- No cross-process cleanup mechanism (acceptable limitation)

### 7.4 Very Long Output
- RingBuffer caps at 500 lines (configurable) — older output is discarded
- `logs` action returns last N lines from buffer, default 50

### 7.5 Non-Interactive Mode (JSON/RPC/Print)
- Tool works normally (process management is non-interactive)
- ProcessPanel and badge are not available (no TUI)
- `/bg` command and `shift+down` shortcut not registered

### 7.6 Concurrent Access
- ProcessManager operations are not thread-safe but JavaScript is single-threaded
- Multiple concurrent `stop()` calls on same process are idempotent (second call returns "not running")

---

## 8. Migration Checklist

- [ ] Create `packages/coding-agent/src/core/features/bg/` directory
- [ ] Implement `ring-buffer.ts` (extracted from manager.ts)
- [ ] Implement `manager.ts` (BackgroundProcessManager + singleton)
- [ ] Implement `badge.ts` (BgBadge animation)
- [ ] Implement `panel.ts` (ProcessPanel TUI component)
- [ ] Implement `index.ts` (feature setup + exports)
- [ ] Implement `tools/bg.ts` (tool definition + factory)
- [ ] Update `tools/index.ts` (add bg to registry)
- [ ] Update `agent-session.ts` (add bgToolDefinition to _customTools)
- [ ] Add session shutdown hook for bg cleanup
- [ ] Add process exit handlers (SIGTERM, SIGINT, exit)
- [ ] Register `/bg` command (via internal extension or new mechanism)
- [ ] Register `shift+down` shortcut
- [ ] Wire up editor badge in interactive mode
- [ ] Wire up task:completed event listener
- [ ] Test: run/stop/list/logs/restart actions
- [ ] Test: subagent can use bg tool via --tools bg
- [ ] Test: subagent exit stops its bg processes
- [ ] Test: main agent bg processes survive subagent exit
- [ ] Test: session shutdown stops all processes
- [ ] Test: ProcessPanel keyboard navigation
- [ ] Test: editor badge animation starts/stops
- [ ] Remove `.pi/extensions/background-process/` after migration verified
- [ ] Run `npm run check` — no errors

---

## 9. Dependencies

**No new npm dependencies required.** The extension only uses:
- `child_process` (Node.js stdlib)
- `@sinclair/typebox` (already a dependency)
- `@mariozechner/pi-ai` (already a dependency, for `StringEnum`)
- `@mariozechner/pi-tui` (already a dependency, for TUI components)

---

## 10. Open Questions

1. **Command/shortcut registration for built-in features:** Should we create a new built-in registration mechanism in AgentSession, or use internal extensions? The spec uses the internal extension approach (Section 3.9) but this should be confirmed.

2. **Badge rendering in interactive mode:** The badge uses `ctx.ui.setEditorBadge()`. This API exists on `ExtensionUIContext`. If bg is registered as a `_customTool` (not an extension), how does it access `setEditorBadge`? Options:
   - Route through the internal extension wrapper (preferred)
   - Expose `setEditorBadge` on AgentSession directly
   - Pass a badge update callback to ProcessManager

3. **Event bus architecture:** The `task:completed` event currently flows through `pi.events` (extension event bus). Should built-in features use the same bus, or a separate internal one? Using the same bus is simpler and allows extension-to-builtin communication.
