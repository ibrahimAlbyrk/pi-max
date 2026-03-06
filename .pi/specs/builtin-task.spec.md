# Built-in Task Management Feature — Implementation Spec

**Status:** Draft
**Migrating from:** `.pi/extensions/task-management/` (55 files, ~8,000+ LOC)
**Target location:** `packages/coding-agent/src/core/tools/task.ts` + `packages/coding-agent/src/core/features/task/`
**Related report:** [extensions-to-builtin.report.md](../reports/extensions-to-builtin.report.md)
**Pattern reference:** [builtin-bg.spec.md](./builtin-bg.spec.md), [builtin-lsp.spec.md](./builtin-lsp.spec.md)

---

## 1. Overview

The task management feature provides full project-scoped task tracking integrated into the agent conversation loop. It is the **largest extension** (~8,000+ LOC, 55 files) and the most complex migration.

### Core Capabilities

1. **`task` tool** — Single LLM-callable tool with 37 actions covering CRUD, status, groups, dependencies, sprints, time, intelligence, export/import, and archiving
2. **Per-file persistence** — `.pi/tasks/` directory with individual JSON files per task/group/sprint + index.json
3. **Session-aware state** — Reconstructs from session branch on fork/tree navigation; compaction-safe via snapshots
4. **TUI components** — NextTasks persistent widget (animated), KanbanBoard overlay, TaskList overlay, TaskDetail overlay, SprintDashboard overlay
5. **Automation** — Auto-start on file edit, auto-complete on test pass, auto-notes from agent activity, file-task correlation
6. **Intelligence** — Context injection (task state into system prompt), priority suggestions, compaction safety
7. **Export/Import** — Markdown export (summary/full), markdown import with merge, TASKS.md sync
8. **Inter-feature events** — `task:completed` (consumed by bg feature), `checkpoint:request`, agent assignment events

---

## 2. Architecture

### 2.1 File Structure

```
packages/coding-agent/src/core/
├── tools/
│   ├── task.ts                          # Tool definition + factory + action dispatch
│   └── index.ts                         # Updated: add task to _toolRegistry
└── features/
    └── task/
        ├── index.ts                     # Feature entry: setup function + singleton
        ├── types.ts                     # All interfaces (Task, TaskStore, Sprint, etc.)
        ├── store.ts                     # Pure state functions (createTask, findTask, etc.)
        ├── storage.ts                   # PerFileTaskStorage (per-file persistence)
        ├── state.ts                     # Hybrid persistence (file + session reconstruction)
        ├── actions/
        │   ├── crud.ts                  # create, get, list, update, delete, bulk_create, bulk_delete, bulk_update
        │   ├── status.ts               # set_status, start, complete, block, unblock, bulk_set_status
        │   └── notes.ts                # add_note
        ├── hierarchy/
        │   └── tree-ops.ts             # create_group, delete_group, rename_group, assign/unassign_group, tree
        ├── dependencies/
        │   └── dep-ops.ts              # add_dependency, remove_dependency, check_dependencies, cycle detection
        ├── sprints/
        │   └── sprint-ops.ts           # create/start/complete sprint, assign/unassign, status, list, log_time, bulk_assign
        ├── intelligence/
        │   ├── analyzer.ts             # handleAnalyze — LLM analysis prompt generation
        │   ├── prioritizer.ts          # calculatePrioritySuggestions — rule-based priority suggestions
        │   ├── context-injector.ts     # buildTaskContext — system prompt injection with budget scaling
        │   ├── compaction-handler.ts   # generateTaskStateSummary — compaction-safe state preservation
        │   └── plan-converter.ts       # extractPlanSteps — parse numbered steps from LLM output
        ├── automation/
        │   ├── config.ts               # TaskAutomationConfig defaults
        │   ├── turn-tracker.ts         # TurnTracker — per-turn file/bash activity tracking
        │   ├── auto-notes.ts           # buildAutoNote, appendAutoNote — automated note generation
        │   ├── file-correlator.ts      # findTaskByFileContext, findBestTaskForFiles — file↔task matching
        │   └── test-detector.ts        # detectTestResult — test pass/fail detection from bash output
        ├── export/
        │   ├── summary-export.ts       # generateSummaryExport — markdown status summary
        │   ├── full-export.ts          # generateFullExport — complete markdown dump
        │   └── task-history.ts         # generateTaskHistory — single-task history
        ├── import/
        │   ├── parser.ts              # parseMarkdownTasks — markdown → ParsedTask[]
        │   ├── tasks-parser.ts        # parseTasksFormat — our export format parser
        │   └── merge.ts              # planMerge, applyMerge — merge imported with existing
        ├── sync/
        │   ├── sync-config.ts         # SyncConfig (TASKS.md sync settings)
        │   └── file-sync.ts           # syncPush, syncPullContent
        ├── rendering/
        │   ├── call-renderer.ts       # taskRenderCall — compact tool call display
        │   ├── result-renderer.ts     # taskRenderResult — rich result display
        │   └── icons.ts              # STATUS_ICONS, PRIORITY_COLORS
        ├── ui/
        │   ├── kanban-board.ts        # KanbanBoard overlay (in-place mutations)
        │   └── helpers.ts             # wordWrap, padRight, truncate, formatDate, PRIORITY_ORDER
        ├── widgets/
        │   ├── next-tasks-widget.ts   # NextTasksComponent — persistent animated widget
        │   └── status-widget.ts       # Status bar indicators
        ├── commands/
        │   ├── tasks-command.ts       # /tasks — task list overlay
        │   ├── board-command.ts       # /board — kanban board
        │   ├── task-detail-command.ts # /task #id — detail view
        │   ├── sprint-command.ts      # /sprint — sprint dashboard
        │   ├── export-command.ts      # /task-export — export to file
        │   ├── import-command.ts      # /task-import — import from file
        │   ├── sync-command.ts        # /sync — TASKS.md bidirectional sync
        │   └── task-history-command.ts # /task-history — task history export
        ├── integration/
        │   ├── event-bus.ts           # TaskEventEmitter + TASK_EVENTS constants
        │   └── extension-hooks.ts     # Git checkpoint, sprint completion, unblock detection
        └── utils/
            ├── compact-parser.ts      # parseCompactTasks — bulk_create text format parser
            ├── response.ts            # toolResult, bulkResult, toolError — standard response formatting
            └── bulk-targets.ts        # resolveBulkTargets — ids/filters/all targeting
```

### 2.2 Integration Points

```
AgentSession constructor
    │
    ├─ _customTools.push(taskToolDefinition)       # ToolDefinition with renderCall/renderResult
    │
    ├─ taskFeature.setup(session)                   # Hook registration
    │   ├─ session_start → load store from .pi/tasks/
    │   ├─ session_shutdown → sync on exit if enabled
    │   ├─ session_switch/fork/tree → reconstruct from branch
    │   ├─ before_agent_start → inject task context into system prompt
    │   ├─ session_before_compact → add task state to compaction summary
    │   ├─ session_compact → persist snapshot via appendEntry
    │   ├─ tool_call → track files, auto-start on edit
    │   ├─ tool_result → track bash output, test detection
    │   ├─ agent_end → auto-notes generation
    │   ├─ turn_start/turn_end → tracker reset, widget refresh
    │   └─ subagent:tasks-assigned/unassigned → agent assignment
    │
    └─ Interactive mode
        ├─ /tasks, /board, /task, /sprint, /task-export, /task-import, /sync, /task-history, /archive, /automation
        ├─ ctrl+shift+t — task list, ctrl+shift+b — kanban, alt+t — toggle widget
        └─ NextTasksComponent persistent widget above editor
```

---

## 3. Type Definitions (`features/task/types.ts`)

Migrate directly from extension — these are stable and well-designed.

```typescript
// Status & Priority
export type TaskStatus = "todo" | "in_progress" | "in_review" | "blocked" | "deferred" | "done";
export type TaskPriority = "critical" | "high" | "medium" | "low";
export const ALL_STATUSES: readonly TaskStatus[] = [...];
export const ALL_PRIORITIES: readonly TaskPriority[] = [...];

// Core Entities
export interface TaskNote { timestamp: string; author: "user" | "agent"; text: string; }
export interface TaskGroup { id: number; name: string; description: string; createdAt: string; }
export interface Task {
  id: number; title: string; description: string; status: TaskStatus;
  priority: TaskPriority; tags: string[]; groupId: number | null;
  dependsOn: number[]; sprintId: number | null; notes: TaskNote[];
  estimatedMinutes: number | null; actualMinutes: number | null;
  startedAt: string | null; completedAt: string | null; createdAt: string;
  assignee: "user" | "agent" | null;
  agentId: string | null; agentName: string | null; agentColor: string | null;
}
export interface Sprint {
  id: number; name: string; description: string;
  status: "planned" | "active" | "completed";
  startDate: string | null; endDate: string | null; completedDate: string | null;
  createdAt: string;
}

// Store
export interface TaskStore {
  tasks: Task[]; groups: TaskGroup[]; sprints: Sprint[];
  nextTaskId: number; nextGroupId: number; nextSprintId: number;
  activeTaskId: number | null; activeSprintId: number | null;
}

// Index (lightweight per-file metadata)
export interface TaskIndex { version: number; nextTaskId: number; ... }
export interface TaskIndexEntry { status; priority; title; assignee; groupId; sprintId; agentName; agentColor; }

// Tool Types
export interface TaskActionParams { action: string; id?: number; ids?: number[]; ... }
export interface TaskToolResult { content: { type: "text"; text: string }[]; details: TaskToolDetails; }
export interface TaskToolDetails { store: TaskStore; action: string; }
```

---

## 4. Storage Layer (`features/task/storage.ts`)

### 4.1 Directory Structure

```
.pi/tasks/
├── index.json              # Lightweight metadata for fast queries
├── tasks/
│   ├── 1.json              # Individual task files
│   ├── 2.json
│   └── ...
├── groups/
│   └── 1.json
├── sprints/
│   └── 1.json
└── archive/
    ├── tasks/              # Archived done tasks
    └── sprints/            # Archived completed sprints
```

### 4.2 PerFileTaskStorage Interface

```typescript
export interface TaskStorage {
  load(): TaskStore;
  save(store: TaskStore): void;
  saveTask(task: Task, store: TaskStore): void;
  saveGroup(group: TaskGroup, store: TaskStore): void;
  saveSprint(sprint: Sprint, store: TaskStore): void;
  deleteTask(id: number, store: TaskStore): void;
  deleteGroup(id: number, store: TaskStore): void;
  saveIndex(store: TaskStore): void;
  archiveTasks(tasks: Task[], store: TaskStore): void;
  archiveSprints(sprints: Sprint[], store: TaskStore): void;
  loadArchivedTasks(): Task[];
  loadArchivedSprints(): Sprint[];
  readonly basePath: string;
}
```

**Key implementation details:**
- Atomic writes via temp file + rename (prevents partial writes)
- Legacy migration: `.pi/tasks.json` → per-file format (auto-detected on first load)
- parentId → groupId migration (old hierarchy format)
- Index includes lightweight metadata (TaskIndexEntry) for fast queries without reading all files
- Archive directory preserves completed work for velocity/history metrics

### 4.3 Concurrent Access (Subagent Safety)

Multiple processes may read/write `.pi/tasks/` simultaneously. The current design uses **last-write-wins** with atomic file operations. This is acceptable because:

1. Task tool calls are serialized within a single agent process
2. Subagents typically work on different tasks (assigned via taskIds)
3. Index is rebuilt from actual files on load — recovers from inconsistency
4. Worst case: a note or status change could be lost if two agents complete the same task simultaneously (extremely rare)

---

## 5. Tool Definition (`tools/task.ts`)

### 5.1 Parameter Schema

The tool uses a single large TypeBox schema with 37 actions dispatched via switch statement:

```typescript
const ALL_ACTIONS = [
  // CRUD
  "create", "get", "list", "update", "delete",
  // Status
  "set_status", "start", "complete", "block", "unblock",
  // Notes
  "add_note",
  // Bulk
  "bulk_create", "bulk_delete", "bulk_update", "bulk_set_status", "bulk_assign_sprint",
  // Groups
  "create_group", "delete_group", "rename_group", "assign_group", "unassign_group", "tree",
  // Dependencies
  "add_dependency", "remove_dependency", "check_dependencies",
  // Sprints
  "create_sprint", "start_sprint", "complete_sprint",
  "assign_sprint", "unassign_sprint", "sprint_status", "list_sprints",
  // Time
  "log_time",
  // Intelligence
  "analyze", "prioritize",
  // Export/Import
  "export", "import_text",
  // Archive
  "archive",
] as const;

const TaskToolParams = Type.Object({
  action: StringEnum(ALL_ACTIONS),
  id: Type.Optional(Type.Number()),
  ids: Type.Optional(Type.Array(Type.Number())),
  title: Type.Optional(Type.String()),
  description: Type.Optional(Type.String()),
  status: Type.Optional(StringEnum([...ALL_STATUSES])),
  priority: Type.Optional(StringEnum([...ALL_PRIORITIES])),
  tags: Type.Optional(Type.Array(Type.String())),
  parentId: Type.Optional(Type.Number()),
  groupId: Type.Optional(Type.Number()),
  assignee: Type.Optional(StringEnum(["user", "agent"])),
  estimatedMinutes: Type.Optional(Type.Number()),
  text: Type.Optional(Type.String()),
  filterStatus: Type.Optional(StringEnum([...ALL_STATUSES])),
  filterPriority: Type.Optional(StringEnum([...ALL_PRIORITIES])),
  filterTag: Type.Optional(Type.String()),
  filterGroupId: Type.Optional(Type.Number()),
  tasks: Type.Optional(Type.Array(Type.Object({
    title: Type.String(),
    description: Type.Optional(Type.String()),
    priority: Type.Optional(StringEnum([...ALL_PRIORITIES])),
    tags: Type.Optional(Type.Array(Type.String())),
    parentId: Type.Optional(Type.Number()),
    assignee: Type.Optional(StringEnum(["user", "agent"])),
    estimatedMinutes: Type.Optional(Type.Number()),
  }))),
});
```

### 5.2 Registration Pattern

Following the established pattern from bg and lsp specs:

```typescript
// ToolDefinition for main agent (with renderCall/renderResult + ExtensionContext)
export const taskToolDefinition: ToolDefinition<typeof TaskToolParams, TaskToolDetails> = {
  name: "task",
  label: "Task Manager",
  description: "...", // Full description with workflow, actions reference, examples
  parameters: TaskToolParams,
  async execute(toolCallId, params, signal, onUpdate, ctx) { /* dispatch */ },
  renderCall(args, options, theme) { return taskRenderCall(args, theme); },
  renderResult(result, options, theme) { return taskRenderResult(result, options, theme); },
};

// Factory for subagent registry (plain AgentTool, no ExtensionContext)
export function createTaskTool(cwd: string): AgentTool<typeof TaskToolParams> { ... }
```

### 5.3 Action Dispatch and Save Strategy

After dispatching to the appropriate action handler, the tool performs **granular saves**:

- Single-task mutations (update, start, complete, etc.): `storage.saveTask()` + `storage.saveIndex()`
- Single-group/sprint mutations: `storage.saveGroup()` / `storage.saveSprint()` + index
- Bulk/delete/archive: `storage.save()` (full rewrite)
- Create: save just the new entity file + index

This minimizes disk I/O — most actions write only 2 files (entity + index).

### 5.4 Event Emission

After mutating actions succeed, events are emitted:
- `task:created`, `task:completed`, `task:started`, `task:blocked` — consumed by bg feature (auto-stop linked processes) and extension hooks
- `task:status_changed` — general status change notification
- `task:deleted`, `task:note_added`, `task:sprint_assigned` — informational

---

## 6. Intelligence Module

### 6.1 Context Injection (`intelligence/context-injector.ts`)

The most critical intelligence feature. Injects task state into the system prompt via `before_agent_start` hook.

**Budget scaling based on remaining context:**
- **Full** (30k+ tokens remaining): Active task details, upcoming tasks, group progress, sprint info
- **Medium** (10k-30k remaining): Active task + next 3 tasks only
- **Minimal** (<10k remaining): Just active task ID and title

**Key behavior:**
- When no active task: strongly prompts LLM to start one with `task start #id`
- When active task: shows description, blocked deps, next steps
- Injected as a `customType: "task-context"` message (not shown in chat, but in LLM context)

### 6.2 Compaction Safety (`intelligence/compaction-handler.ts`)

When the session auto-compacts:
1. `session_before_compact`: Appends task state summary to compaction summary
2. `session_compact`: Persists full store snapshot via `appendEntry("task-store-snapshot")`

This ensures task state survives compaction without loss.

### 6.3 Priority Suggestions (`intelligence/prioritizer.ts`)

Rule-based (no LLM call required):
- Tasks blocking 2+ others → suggest high/critical
- Old in_progress tasks (2x+ over estimate) → suggest high
- Tasks with all deps met but still todo → suggest medium

---

## 7. Automation Module

### 7.1 Turn Tracker (`automation/turn-tracker.ts`)

Tracks per-turn agent activity:
- Files edited/written/read
- Bash commands executed (filtered: ignores ls, pwd, echo, cd)
- Test runs detected (jest, vitest, pytest, etc.)

Reset at `turn_start`, consumed at `agent_end` for auto-notes.

### 7.2 Auto-Start (`automation/automation-hooks.ts`)

On `tool_call` for edit/write:
- Find matching task via file correlator (path match, keyword match, active fallback)
- If matching todo task found → auto-start it

### 7.3 Auto-Notes (`automation/auto-notes.ts`)

On `agent_end`:
- Build note from turn tracker data: "Edited: X | Ran: Y | Tests: Z"
- Extract brief LLM summary (first meaningful sentence, skip code blocks)
- Append to active or best-matching task

### 7.4 Test Detection (`automation/test-detector.ts`)

Detects test commands and pass/fail from bash output:
- Commands: jest, vitest, mocha, pytest, cargo test, go test, npm test
- Pass patterns: "all tests passed", "0 failed"
- Fail patterns: "FAIL", "Error:", "test result: FAILED"

---

## 8. TUI Components

### 8.1 NextTasksComponent (Persistent Widget)

The most complex TUI component (~1540 lines). Displays above the editor:

**Features:**
- Active sprint header with progress bar
- In-progress tasks with shine animation
- Todo tasks
- Done tasks (strikethrough)
- Agent tags with pulse animation
- Collapse/expand with transition animation
- Task slide-in animation on add

**Animations:**
- Pulse: Sine wave oscillation of agent color (2500ms cycle)
- Shine: Gaussian bell curve sweep across task title (2000ms cycle)
- Fade: Progressive dimming for expanded mode
- Slide-in: Tasks added slide from right (300ms, 12 char distance)
- Transition: Collapse/expand frame-by-frame (35ms per frame)

### 8.2 KanbanBoard (Overlay)

Full-screen interactive kanban board:
- Columns: TODO | IN PROGRESS | IN REVIEW | DONE | BLOCKED
- Responsive column layout (60/80/120+ char widths)
- In-place mutations (move between columns, change priority)
- Keyboard: arrows navigate, shift+arrows move, tab toggle done, p cycle priority
- Returns `{ type: "detail"; taskId }` to open detail view, then returns to board

### 8.3 TaskList Overlay

Scrollable task list with status summary, group headers, keyboard navigation.

### 8.4 TaskDetail Overlay

Full task metadata view with scrollable content, all fields displayed.

### 8.5 SprintDashboard

Sprint progress with velocity metrics, task counts, ETA calculation.

---

## 9. Export/Import/Sync

### 9.1 Export Formats

- **Summary**: Status counts, active sprint progress, task lists by status
- **Full**: Groups as H2, tasks as H3, all metadata, notes, sprints

### 9.2 Import

- Auto-detect format (our export format vs. generic checklist)
- Parse markdown → `ParsedTask[]`
- Merge plan: match by title (case-insensitive), compute changes
- Apply: 2-pass (create → resolve deps/groups by title)

### 9.3 TASKS.md Sync

- Push: Write store to TASKS.md (summary or full format)
- Pull: Read TASKS.md, parse, merge with existing
- Config: enabled, path, format, autoSync, syncOnExit

---

## 10. Slash Commands

| Command | Description | Key Features |
|---------|-------------|-------------|
| `/tasks` | Task list overlay | Status filters, group headers, detail navigation |
| `/board` | Kanban board | In-place mutations, column navigation |
| `/task #id` | Task detail view | Scrollable metadata, notes, deps |
| `/sprint` | Sprint dashboard | Progress bar, velocity, ETA |
| `/task-export` | Export to file | Summary or full format |
| `/task-import` | Import from file | Merge preview, format detection |
| `/sync` | TASKS.md sync | Push/pull, auto-sync config |
| `/task-history` | Task history export | Full timeline markdown |
| `/archive` | Archive done tasks | Move to archive/, clean working set |
| `/automation` | Toggle automation | autostart/autocomplete/autonote on/off |
| `/backlog` | Unassigned tasks | Tasks not in any sprint |

### Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `ctrl+shift+t` | Open task list overlay |
| `ctrl+shift+b` | Open kanban board |
| `alt+t` | Toggle task widget collapse |

---

## 11. Inter-Feature Communication

### 11.1 Events Emitted

```typescript
const TASK_EVENTS = {
  CREATED: "task:created",
  UPDATED: "task:updated",
  DELETED: "task:deleted",
  STATUS_CHANGED: "task:status_changed",
  COMPLETED: "task:completed",
  STARTED: "task:started",
  BLOCKED: "task:blocked",
  SPRINT_ASSIGNED: "task:sprint_assigned",
  NOTE_ADDED: "task:note_added",
  AUTO_STARTED: "task:auto_started",
};
```

### 11.2 Events Consumed

- `subagent:tasks-assigned` → assign agent to tasks (agentId, agentName, agentColor)
- `subagent:tasks-unassigned` → clear agent assignment

### 11.3 Events Consumed by Other Features

- **bg feature** listens to `task:completed` → auto-stop linked processes
- **Git checkpoint** (future): `checkpoint:request` emitted on task completion

---

## 12. Subagent Behavior

### 12.1 Tool Access

Subagents access task via the tool registry factory:

```
pi --mode json --tools read,bash,task "Create tasks for the authentication module"
```

### 12.2 Subagent Limitations

- **No TUI**: renderCall/renderResult not available in JSON mode
- **No hooks**: automation (auto-start, auto-notes) only runs in main agent
- **No widget**: NextTasksComponent only in interactive mode
- **Shared storage**: Reads/writes same `.pi/tasks/` files — last-write-wins

### 12.3 Subagent Task Assignment

When subagents are spawned with task IDs, the subagent system emits `subagent:tasks-assigned` with agent metadata. The task feature updates `agentId`/`agentName`/`agentColor` on those tasks. When the subagent exits, `subagent:tasks-unassigned` clears the assignment.

---

## 13. Required Changes to Existing Code

### 13.1 New Dependencies

**None.** The task-management extension uses only Node.js stdlib + existing coding-agent dependencies (`@sinclair/typebox`, `@mariozechner/pi-ai`, `@mariozechner/pi-tui`).

### 13.2 tools/index.ts

```diff
+ import { createTaskTool } from "./task.js";

  const _toolRegistry = {
    // ... existing tools ...
+   task: (cwd: string) => createTaskTool(cwd),
  };
```

### 13.3 agent-session.ts

```typescript
import { taskToolDefinition } from "./tools/task.js";
import { setupTaskFeature } from "./features/task/index.js";

// In constructor:
this._customTools = [
  ...(config.customTools ?? []),
  askUserTool as unknown as ToolDefinition,
  bgToolDefinition as unknown as ToolDefinition,
  lspDiagnosticsDefinition as unknown as ToolDefinition,
  lspDefinitionDefinition as unknown as ToolDefinition,
  lspReferencesDefinition as unknown as ToolDefinition,
  taskToolDefinition as unknown as ToolDefinition,
];

// After _buildRuntime():
setupTaskFeature(this);
```

### 13.4 Hook Registration

The task feature needs access to these agent-session hooks (same mechanism proposed in bg spec):

- `onSessionStart(handler)`
- `onSessionShutdown(handler)`
- `onSessionSwitch(handler)` / `onSessionFork(handler)` / `onSessionTree(handler)`
- `onBeforeAgentStart(handler)` — must support returning `{ message }` for context injection
- `onSessionBeforeCompact(handler)` — must support returning modified compaction
- `onSessionCompact(handler)`
- `onToolCall(handler)` — must provide toolName + input
- `onToolResult(handler)` — must provide toolName + input + result
- `onAgentEnd(handler)`
- `onTurnStart(handler)` / `onTurnEnd(handler)`
- `onEvent(name, handler)` — for `subagent:tasks-assigned` etc.
- `appendEntry(type, data)` — for compaction snapshots

This is the most demanding set of hooks of any built-in feature. The hook infrastructure designed for bg/lsp must scale to support all of these.

---

## 14. Feature Setup (`features/task/index.ts`)

```typescript
export function setupTaskFeature(session: AgentSession): void {
  // Create shared context (mutable state container)
  const sc: SharedContext = {
    store: createDefaultStore(),
    storage: null,
    automationConfig: DEFAULT_CONFIG,
    syncConfig: DEFAULT_SYNC_CONFIG,
    taskEvents: new TaskEventEmitter(session.eventBus),
    turnTracker: new TurnTracker(),
    widgetCollapsed: false,
    saveToFile: () => { if (sc.storage) persistToStorage(sc.store, sc.storage); },
    saveTaskFile: (taskId) => { /* granular save */ },
    saveIndex: () => { if (sc.storage) sc.storage.saveIndex(sc.store); },
    refreshWidgets: (ctx) => { /* update NextTasks + status */ },
  };

  // Register all hooks
  registerSessionHooks(session, sc);
  registerAutomationHooks(session, sc);
  registerIntelligenceHooks(session, sc);
  registerIntegrationHooks(session, sc);

  // Register commands and shortcuts (via internal extension)
  registerTaskCommands(session, sc);
  registerTaskShortcuts(session, sc);
}
```

---

## 15. Migration Strategy

Given the size and complexity, this migration should be done in sub-phases:

### Phase A: Core Types + Storage + Store (Foundation)
- Migrate `types.ts`, `store.ts`, `storage.ts`, `state.ts`
- No tool registration yet — just data layer
- Test: load/save/archive operations work correctly

### Phase B: Tool + Actions (Core Functionality)
- Migrate `tools/task.ts` with action dispatch
- Migrate all action modules: `actions/`, `hierarchy/`, `dependencies/`, `sprints/`
- Migrate `utils/` (compact-parser, response, bulk-targets)
- Register tool in index.ts and agent-session.ts
- Test: all 37 actions work, subagent can use `--tools task`

### Phase C: Intelligence + Automation (Agent Integration)
- Migrate `intelligence/` (context-injector, compaction-handler, prioritizer, analyzer)
- Migrate `automation/` (turn-tracker, auto-notes, file-correlator, test-detector, config)
- Wire up all hooks
- Test: context injection, auto-start, auto-notes, compaction safety

### Phase D: TUI Components (Interactive Mode)
- Migrate `widgets/` (next-tasks-widget, status-widget)
- Migrate `ui/` (kanban-board, helpers)
- Migrate `rendering/` (call-renderer, result-renderer, icons)
- Migrate `commands/` (all 8 command files)
- Wire up shortcuts
- Test: all overlays and widgets render correctly

### Phase E: Export/Import/Sync (Polish)
- Migrate `export/`, `import/`, `sync/`
- Migrate remaining commands
- Test: round-trip export → import, TASKS.md sync

---

## 16. Estimated Effort

| Sub-phase | Files | LOC (est.) | Effort |
|-----------|-------|-----------|--------|
| Phase A: Foundation | 4 | ~800 | 3h |
| Phase B: Tool + Actions | 10 | ~2,500 | 6h |
| Phase C: Intelligence + Automation | 10 | ~1,200 | 4h |
| Phase D: TUI Components | 15 | ~3,000 | 5h |
| Phase E: Export/Import/Sync | 10 | ~800 | 2h |
| **Total** | **~49** | **~8,300** | **~20h** |

---

## 17. Edge Cases

### 17.1 Store Corruption Recovery
- If index.json is corrupt: rebuild from individual task/group/sprint files
- If task file is corrupt: skip with error log, continue loading others
- If entire `.pi/tasks/` is missing: create fresh store

### 17.2 ID Collisions After Archive
- `recalculateNextIds()` ensures IDs don't collide after archiving
- Archived tasks retain their original IDs in archive/ directory

### 17.3 Session Branch Reconstruction
- On fork/tree: reconstruct store from latest `task-store-snapshot` entry in branch
- Fallback: load from file storage if no session data exists

### 17.4 Concurrent Subagent Writes
- Last-write-wins for individual task files
- Index rebuilt on load — self-healing
- Atomic writes (tmp+rename) prevent partial writes

### 17.5 Bulk Operations Safety
- `resolveBulkTargets()` with no params + no ids = ALL tasks
- Operations log affected IDs for audit trail
- `bulkResult()` uses minimal snapshot to save context tokens

---

## 18. Migration Checklist

- [ ] Create `packages/coding-agent/src/core/features/task/` directory structure
- [ ] Migrate `types.ts` (all interfaces, types, constants)
- [ ] Migrate `store.ts` (pure state functions)
- [ ] Migrate `storage.ts` (PerFileTaskStorage with atomic writes)
- [ ] Migrate `state.ts` (hybrid persistence, session reconstruction)
- [ ] Implement `tools/task.ts` (tool definition + factory + dispatch)
- [ ] Migrate `actions/crud.ts` (create, get, list, update, delete, bulk_create, bulk_delete, bulk_update)
- [ ] Migrate `actions/status.ts` (set_status, start, complete, block, unblock, bulk_set_status)
- [ ] Migrate `actions/notes.ts` (add_note)
- [ ] Migrate `hierarchy/tree-ops.ts` (group operations + tree rendering)
- [ ] Migrate `dependencies/dep-ops.ts` (dependency operations + cycle detection)
- [ ] Migrate `sprints/sprint-ops.ts` (sprint operations + bulk assign)
- [ ] Migrate `utils/compact-parser.ts` (bulk_create text format)
- [ ] Migrate `utils/response.ts` (toolResult, bulkResult, toolError)
- [ ] Migrate `utils/bulk-targets.ts` (resolveBulkTargets)
- [ ] Update `tools/index.ts` (add task to registry)
- [ ] Update `agent-session.ts` (add tool + call setupTaskFeature)
- [ ] Migrate `intelligence/context-injector.ts` (system prompt injection)
- [ ] Migrate `intelligence/compaction-handler.ts` (compaction safety)
- [ ] Migrate `intelligence/prioritizer.ts` (priority suggestions)
- [ ] Migrate `intelligence/analyzer.ts` (LLM analysis prompt)
- [ ] Migrate `intelligence/plan-converter.ts` (plan step extraction)
- [ ] Migrate `automation/config.ts` (automation settings)
- [ ] Migrate `automation/turn-tracker.ts` (per-turn tracking)
- [ ] Migrate `automation/auto-notes.ts` (auto note generation)
- [ ] Migrate `automation/file-correlator.ts` (file↔task matching)
- [ ] Migrate `automation/test-detector.ts` (test pass/fail detection)
- [ ] Wire up all intelligence/automation hooks
- [ ] Migrate `rendering/icons.ts` (status/priority icons)
- [ ] Migrate `rendering/call-renderer.ts` (tool call display)
- [ ] Migrate `rendering/result-renderer.ts` (tool result display)
- [ ] Migrate `ui/helpers.ts` (UI utilities)
- [ ] Migrate `ui/kanban-board.ts` (kanban overlay)
- [ ] Migrate `widgets/next-tasks-widget.ts` (persistent widget)
- [ ] Migrate `widgets/status-widget.ts` (status bar)
- [ ] Migrate `commands/` (all 8 command files)
- [ ] Migrate `integration/event-bus.ts` (TaskEventEmitter)
- [ ] Migrate `integration/extension-hooks.ts` (git checkpoint, etc.)
- [ ] Migrate `export/` (summary, full, history)
- [ ] Migrate `import/` (parser, tasks-parser, merge)
- [ ] Migrate `sync/` (config, file-sync)
- [ ] Register all slash commands
- [ ] Register all keyboard shortcuts
- [ ] Wire up NextTasksComponent to interactive mode
- [ ] Test: all 37 tool actions
- [ ] Test: subagent can use `--tools task`
- [ ] Test: .pi/tasks/ persistence round-trip
- [ ] Test: session branch reconstruction
- [ ] Test: compaction preserves task state
- [ ] Test: auto-start, auto-notes, test detection
- [ ] Test: context injection with budget scaling
- [ ] Test: kanban board in-place mutations
- [ ] Test: export → import round-trip
- [ ] Test: TASKS.md sync push/pull
- [ ] Remove `.pi/extensions/task-management/` after migration verified
- [ ] Run `npm run check` — no errors

---

## 19. Open Questions

1. **Hook infrastructure scale:** The task feature needs ~15 different hooks. Should we formalize a `BuiltinFeatureHooks` interface that all features implement, or keep the ad-hoc `session.onXxx()` approach from the bg spec?

2. **SharedContext pattern:** The extension uses a mutable `SharedContext` object passed to all hook modules. In built-in form, should this be a class instance, a module-level singleton, or kept as the current plain-object-with-getters pattern?

3. **NextTasksWidget integration:** This is a persistent widget (not an overlay). How does it integrate with interactive mode's layout? The extension uses `ctx.ui.setEditorWidget()` — does this API exist on AgentSession for built-in features?

4. **Context injection priority:** When both DPS (future built-in) and task management inject into `before_agent_start`, what's the ordering? Task context should come after the system prompt but before DPS reminders.

5. **Subagent auto-start:** Should automation hooks (auto-start on file edit, auto-notes) run in subagent processes, or only in the main agent? Current extension only runs in main agent. For subagents it adds overhead without clear benefit.
