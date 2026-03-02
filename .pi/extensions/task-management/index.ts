/**
 * Task Management Extension for Pi CLI
 *
 * Global extension: ~/.pi/agent/extensions/task-management/
 * Storage: .pi/tasks/ (per-file, project-scoped, persists across sessions)
 *
 * Phase 1: Core CRUD + status
 * Phase 2: Kanban board, widgets, shortcuts
 * Phase 3: Hierarchy, dependencies, sprints, time
 * Phase 4: Intelligent automation, context injection, compaction safety
 * Phase 5: Export, import, TASKS.md sync
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { StringEnum } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { Key } from "@mariozechner/pi-tui";

import type { TaskStore, TaskActionParams, TaskToolResult } from "./types.js";
import { createDefaultStore, createTask, createLightSnapshot, findTask, recalculateNextIds } from "./store.js";
import { PerFileTaskStorage, type TaskStorage } from "./storage.js";
import { persistToStorage } from "./state.js";

// Actions
import { handleCreate, handleGet, handleList, handleUpdate, handleDelete, handleBulkCreate, handleBulkDelete, handleBulkUpdate } from "./actions/crud.js";
import { handleSetStatus, handleStart, handleComplete, handleBlock, handleUnblock, handleBulkSetStatus } from "./actions/status.js";
import { handleAddNote } from "./actions/notes.js";
import { handleMoveUnder, handlePromote, handleFlatten, handleTree } from "./hierarchy/tree-ops.js";
import { handleAddDependency, handleRemoveDependency, handleCheckDependencies } from "./dependencies/dep-ops.js";
import {
	handleCreateSprint, handleStartSprint, handleCompleteSprint,
	handleAssignSprint, handleUnassignSprint, handleSprintStatus,
	handleListSprints, handleLogTime, handleBulkAssignSprint,
} from "./sprints/sprint-ops.js";

// Rendering
import { taskRenderCall } from "./rendering/call-renderer.js";
import { taskRenderResult } from "./rendering/result-renderer.js";

// Commands
import { registerTasksCommand } from "./commands/tasks-command.js";
import { registerTaskDetailCommand } from "./commands/task-detail-command.js";
import { registerBoardCommand } from "./commands/board-command.js";
import { registerTreeCommand } from "./commands/tree-command.js";
import { registerSprintCommand } from "./commands/sprint-command.js";
import { registerExportCommand } from "./commands/export-command.js";
import { registerImportCommand } from "./commands/import-command.js";
import { registerSyncCommand } from "./commands/sync-command.js";
import { registerTaskHistoryCommand } from "./commands/task-history-command.js";

// Widgets
import { updateStatusWidgets } from "./widgets/status-widget.js";
import { updateNextTasksWidget } from "./widgets/next-tasks-widget.js";

// Intelligence & Automation
import { DEFAULT_CONFIG, type TaskAutomationConfig } from "./automation/config.js";
import { TurnTracker } from "./automation/turn-tracker.js";
import { handleAnalyze } from "./intelligence/analyzer.js";
import { calculatePrioritySuggestions } from "./intelligence/prioritizer.js";
import { TaskEventEmitter } from "./integration/event-bus.js";
import { registerAllHooks } from "./integration/extension-hooks.js";

// Export & Import
import { generateSummaryExport } from "./export/summary-export.js";
import { generateFullExport } from "./export/full-export.js";
import { parseMarkdownTasks } from "./import/parser.js";
import { planMerge, applyMerge } from "./import/merge.js";
import { DEFAULT_SYNC_CONFIG, type SyncConfig } from "./sync/sync-config.js";
import { syncPush } from "./sync/file-sync.js";

// Hook modules (session, automation, intelligence)
import type { SharedContext } from "./hooks/shared-context.js";
import { registerSessionHooks } from "./hooks/session-hooks.js";
import { registerAutomationHooks } from "./hooks/automation-hooks.js";
import { registerIntelligenceHooks } from "./hooks/intelligence-hooks.js";

// ─── Extension Entry Point ──────────────────────────────────────

export default function taskManagementExtension(pi: ExtensionAPI) {
	let store: TaskStore = createDefaultStore();
	let storage: TaskStorage | null = null;
	let widgetCollapsed = false;
	let automationConfig: TaskAutomationConfig = { ...DEFAULT_CONFIG };
	let syncConfig: SyncConfig = { ...DEFAULT_SYNC_CONFIG };

	const taskEvents = new TaskEventEmitter(pi);
	const turnTracker = new TurnTracker();
	const getStore = () => store;

	// ─── Utility Functions ───────────────────────────────────────

	const saveToFile = (ctx?: ExtensionContext) => {
		if (storage) persistToStorage(store, storage);
		if (syncConfig.autoSync && ctx) syncPush(store, syncConfig, ctx.cwd);
	};

	const saveTaskFile = (taskId: number, ctx?: ExtensionContext) => {
		if (!storage) return;
		const task = store.tasks.find((t) => t.id === taskId);
		if (task) {
			storage.saveTask(task, store);
		} else {
			persistToStorage(store, storage);
		}
		if (syncConfig.autoSync && ctx) syncPush(store, syncConfig, ctx.cwd);
	};

	const saveIndex = () => {
		if (storage) storage.saveIndex(store);
	};

	const refreshWidgets = (ctx: ExtensionContext) => {
		updateStatusWidgets(store, ctx);
		updateNextTasksWidget(store, ctx, widgetCollapsed);
	};

	const onUIMutate = () => { saveToFile(); };

	// ─── Archive Helper ──────────────────────────────────────────

	const archiveDoneTasks = (s: TaskStore): TaskToolResult => {
		const activeSprintIds = new Set(
			s.sprints.filter((sp) => sp.status !== "completed").map((sp) => sp.id),
		);
		const tasksToArchive = s.tasks.filter((t) =>
			t.status === "done" &&
			(t.sprintId === null || !activeSprintIds.has(t.sprintId)),
		);
		const sprintsToArchive = s.sprints.filter((sp) => sp.status === "completed");

		if (tasksToArchive.length === 0 && sprintsToArchive.length === 0) {
			return {
				content: [{ type: "text", text: "Nothing to archive — no done tasks or completed sprints." }],
				details: { store: createLightSnapshot(s), action: "archive" },
			};
		}

		const archivedTaskIds = new Set(tasksToArchive.map((t) => t.id));
		const archivedSprintIds = new Set(sprintsToArchive.map((sp) => sp.id));

		if (storage) {
			if (tasksToArchive.length > 0) storage.archiveTasks(tasksToArchive, s);
			if (sprintsToArchive.length > 0) storage.archiveSprints(sprintsToArchive, s);
		}

		s.tasks = s.tasks.filter((t) => !archivedTaskIds.has(t.id));
		s.sprints = s.sprints.filter((sp) => !archivedSprintIds.has(sp.id));

		if (s.activeTaskId !== null && archivedTaskIds.has(s.activeTaskId)) {
			s.activeTaskId = null;
		}

		recalculateNextIds(s);

		const lines: string[] = [];
		if (tasksToArchive.length > 0) {
			lines.push(`Archived ${tasksToArchive.length} done task(s): ${tasksToArchive.map((t) => `#${t.id}`).join(", ")}`);
		}
		if (sprintsToArchive.length > 0) {
			lines.push(`Archived ${sprintsToArchive.length} completed sprint(s): ${sprintsToArchive.map((sp) => `#S${sp.id}`).join(", ")}`);
		}
		lines.push(`Active: ${s.tasks.length} tasks, ${s.sprints.length} sprints remaining.`);

		return {
			content: [{ type: "text", text: lines.join("\n") }],
			details: { store: createLightSnapshot(s), action: "archive" },
		};
	};

	// ─── Shared Context for Hook Modules ─────────────────────────

	// The SharedContext object gives hook modules mutable access to
	// extension state without relying on closures in a single giant file.
	// Property getters/setters keep the binding live.

	const sharedContext: SharedContext = {
		get store() { return store; },
		set store(v) { store = v; },
		get storage() { return storage; },
		set storage(v) { storage = v; },
		get automationConfig() { return automationConfig; },
		set automationConfig(v) { automationConfig = v; },
		get syncConfig() { return syncConfig; },
		set syncConfig(v) { syncConfig = v; },
		taskEvents,
		turnTracker,
		get widgetCollapsed() { return widgetCollapsed; },
		set widgetCollapsed(v) { widgetCollapsed = v; },
		saveToFile,
		saveTaskFile,
		saveIndex,
		refreshWidgets,
	};

	// ─── Register Event Hooks ────────────────────────────────────

	registerAllHooks(pi, getStore);          // inter-extension hooks
	registerSessionHooks(pi, sharedContext);  // session lifecycle
	registerAutomationHooks(pi, sharedContext); // file tracking, auto-start, test detect, auto-notes, plan mode
	registerIntelligenceHooks(pi, sharedContext); // context injection, compaction safety

	// ─── Tool Schema ─────────────────────────────────────────────

	const ALL_ACTIONS = [
		"create", "get", "list", "update", "delete",
		"set_status", "start", "complete", "block", "unblock",
		"add_note", "bulk_create", "bulk_delete", "bulk_update", "bulk_set_status", "bulk_assign_sprint",
		"move_under", "promote", "flatten", "tree",
		"add_dependency", "remove_dependency", "check_dependencies",
		"create_sprint", "start_sprint", "complete_sprint",
		"assign_sprint", "unassign_sprint", "sprint_status", "list_sprints",
		"log_time",
		"analyze", "prioritize",
		"export", "import_text",
		"archive",
	] as const;

	const TaskToolParams = Type.Object({
		action: StringEnum(ALL_ACTIONS),
		id: Type.Optional(Type.Number({ description: "Task or Sprint ID" })),
		ids: Type.Optional(Type.Array(Type.Number(), { description: "Multiple task IDs for bulk operations (bulk_delete, bulk_set_status, bulk_update, bulk_assign_sprint)" })),
		title: Type.Optional(Type.String({ description: "Task/Sprint title or name" })),
		description: Type.Optional(Type.String({ description: "Task/Sprint description" })),
		status: Type.Optional(StringEnum(["todo", "in_progress", "in_review", "blocked", "deferred", "done"] as const)),
		priority: Type.Optional(StringEnum(["critical", "high", "medium", "low"] as const)),
		tags: Type.Optional(Type.Array(Type.String(), { description: "Tags for categorization" })),
		parentId: Type.Optional(Type.Number({ description: "Parent task ID, dependency target, or sprint ID (context-dependent)" })),
		assignee: Type.Optional(StringEnum(["user", "agent"] as const)),
		estimatedMinutes: Type.Optional(Type.Number({ description: "Estimated time in minutes, or minutes to log" })),
		text: Type.Optional(Type.String({ description: "Note text, block reason, or analysis prompt" })),
		filterStatus: Type.Optional(StringEnum(["todo", "in_progress", "in_review", "blocked", "deferred", "done"] as const)),
		filterPriority: Type.Optional(StringEnum(["critical", "high", "medium", "low"] as const)),
		filterTag: Type.Optional(Type.String({ description: "Filter by tag" })),
		filterParentId: Type.Optional(Type.Number({ description: "Filter by parent task ID" })),
		tasks: Type.Optional(Type.Array(Type.Object({
			title: Type.String(),
			description: Type.Optional(Type.String()),
			priority: Type.Optional(StringEnum(["critical", "high", "medium", "low"] as const)),
			tags: Type.Optional(Type.Array(Type.String())),
			parentId: Type.Optional(Type.Number({ description: "Positive: existing task ID. Negative: batch-internal ref (-1=1st task in batch, -2=2nd, etc.)" })),
			assignee: Type.Optional(StringEnum(["user", "agent"] as const)),
			estimatedMinutes: Type.Optional(Type.Number()),
		}), { description: "Array of tasks for bulk_create. Use negative parentId for batch-internal parent refs: -1=first task in batch, -2=second, etc." })),
	});

	const MUTATING_ACTIONS = new Set([
		"create", "update", "delete", "set_status", "start",
		"complete", "block", "unblock", "add_note", "bulk_create",
		"bulk_delete", "bulk_update", "bulk_set_status", "bulk_assign_sprint",
		"move_under", "promote", "flatten",
		"add_dependency", "remove_dependency",
		"create_sprint", "start_sprint", "complete_sprint",
		"assign_sprint", "unassign_sprint", "log_time",
		"import_text", "archive",
	]);

	// ─── Tool Registration ───────────────────────────────────────

	pi.registerTool({
		name: "task",
		label: "Task Manager",
		description: `Structured project task management. Tasks persist per-project across sessions.

## Workflow — ALWAYS follow this pattern:
1. PLAN first: Break work into discrete, trackable tasks BEFORE writing code.
2. CREATE tasks in bulk: Use bulk_create with text param (compact format, ~5x faster than JSON):
   bulk_create text="Epic [high] #backend\n  Subtask A [high] @agent ~30m\n  Subtask B\n    Sub-subtask"
   Rules: indent=hierarchy, [priority], #tag, @assignee, ~time, > description line
3. START a task: Call start before working on it (sets active context).
4. WORK on it: Write code, run tests — one task at a time.
5. COMPLETE it: Call complete when done, then start the next.

## Task Granularity:
- Each task = ONE concrete deliverable (a function, an endpoint, a component, a fix).
- Parent tasks = epics/features grouping related subtasks.
- If a task takes >30 min or has multiple steps, split it into subtasks.

## Actions Reference:
CRUD: create, get, list, update, delete, bulk_create
Bulk: bulk_delete (ids), bulk_set_status (ids+status), bulk_update (ids+fields), bulk_assign_sprint (ids+parentId)
Status: set_status, start, complete, block, unblock
Hierarchy: move_under (id + parentId), promote (id), flatten (id), tree
Dependencies: add_dependency (id depends on parentId), remove_dependency, check_dependencies
Sprints: create_sprint, start_sprint, complete_sprint, assign_sprint (id=task, parentId=sprint), unassign_sprint, sprint_status, list_sprints
Time: log_time (id, estimatedMinutes=minutes to add), add_note (id, text)
Intelligence: analyze (text=prompt), prioritize (suggests priority changes)
Export: export (text=summary|full), import_text (text=markdown content to parse and import)
Archive: archive (move done tasks + completed sprints to archive, keeps working set clean)

## Bulk Operations — 3 targeting modes (pick one):
1. **ids array**: bulk_delete ids=[1,2,3] — specific tasks
2. **filters**: bulk_delete filterStatus="done" — matching tasks
3. **nothing**: bulk_delete — ALL tasks

Examples:
- bulk_delete (no params) → delete ALL tasks
- bulk_delete filterStatus="done" → delete all done tasks
- bulk_delete ids=[1,2,3] → delete specific tasks
- bulk_set_status status="done" → complete ALL tasks
- bulk_set_status filterStatus="todo" status="in_progress" → start all todos
- bulk_update filterPriority="low" priority="medium" → upgrade all low→medium
- bulk_update assignee="agent" → assign ALL tasks to agent
- bulk_assign_sprint filterStatus="todo" parentId=1 → assign all todos to sprint #S1`,

		parameters: TaskToolParams,

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const p = params as TaskActionParams;
			let result: TaskToolResult;

			// ── Action Dispatch ──────────────────────────────────
			switch (p.action) {
				case "create": result = handleCreate(store, p); break;
				case "get": result = handleGet(store, p); break;
				case "list": result = handleList(store, p); break;
				case "update": result = handleUpdate(store, p); break;
				case "delete": result = handleDelete(store, p); break;
				case "set_status": result = handleSetStatus(store, p); break;
				case "start": result = handleStart(store, p); break;
				case "complete": result = handleComplete(store, p); break;
				case "block": result = handleBlock(store, p); break;
				case "unblock": result = handleUnblock(store, p); break;
				case "add_note": result = handleAddNote(store, p); break;
				case "bulk_create": result = handleBulkCreate(store, p); break;
				case "bulk_delete": result = handleBulkDelete(store, p); break;
				case "bulk_update": result = handleBulkUpdate(store, p); break;
				case "bulk_set_status": result = handleBulkSetStatus(store, p); break;
				case "bulk_assign_sprint": result = handleBulkAssignSprint(store, p); break;
				case "move_under": result = handleMoveUnder(store, p); break;
				case "promote": result = handlePromote(store, p); break;
				case "flatten": result = handleFlatten(store, p); break;
				case "tree": result = handleTree(store, p); break;
				case "add_dependency": result = handleAddDependency(store, p); break;
				case "remove_dependency": result = handleRemoveDependency(store, p); break;
				case "check_dependencies": result = handleCheckDependencies(store, p); break;
				case "create_sprint": result = handleCreateSprint(store, p); break;
				case "start_sprint": result = handleStartSprint(store, p); break;
				case "complete_sprint": result = handleCompleteSprint(store, p); break;
				case "assign_sprint": result = handleAssignSprint(store, p); break;
				case "unassign_sprint": result = handleUnassignSprint(store, p); break;
				case "sprint_status": result = handleSprintStatus(store, p); break;
				case "list_sprints": result = handleListSprints(store, p); break;
				case "log_time": result = handleLogTime(store, p); break;
				case "archive": result = archiveDoneTasks(store); break;
				case "analyze": result = handleAnalyze(store, p.text); break;
				case "prioritize": {
					const suggestions = calculatePrioritySuggestions(store);
					if (suggestions.length === 0) {
						result = {
							content: [{ type: "text", text: "No priority changes suggested — current priorities look reasonable." }],
							details: { store: createLightSnapshot(store), action: "prioritize" },
						};
					} else {
						const lines = suggestions.map((s) =>
							`#${s.taskId} (${s.title}): ${s.currentPriority} → ${s.suggestedPriority} — ${s.reason}`,
						);
						result = {
							content: [{ type: "text", text: `Priority suggestions:\n${lines.join("\n")}` }],
							details: { store: createLightSnapshot(store), action: "prioritize" },
						};
					}
					break;
				}
				case "export": {
					const fmt = (p.text ?? "full") as "summary" | "full";
					const content = fmt === "summary"
						? generateSummaryExport(store)
						: generateFullExport(store);
					result = {
						content: [{ type: "text", text: `Exported ${store.tasks.length} tasks (${fmt}):\n\n${content}` }],
						details: { store: createLightSnapshot(store), action: "export" },
					};
					break;
				}
				case "import_text": {
					const mdText = p.text ?? "";
					if (!mdText.trim()) {
						result = {
							content: [{ type: "text", text: "No markdown content provided. Use text parameter with markdown task content." }],
							details: { store: createLightSnapshot(store), action: "import_text" },
						};
						break;
					}
					const parsed = parseMarkdownTasks(mdText, "auto");
					if (parsed.length === 0) {
						result = {
							content: [{ type: "text", text: "No tasks found in the provided markdown." }],
							details: { store: createLightSnapshot(store), action: "import_text" },
						};
						break;
					}
					const mPlan = planMerge(store.tasks, parsed);
					const mResult = applyMerge(store, mPlan);
					result = {
						content: [{ type: "text", text: `Imported: ${mResult.created} new, ${mResult.updated} updated from markdown text.` }],
						details: { store: createLightSnapshot(store), action: "import_text" },
					};
					break;
				}
				default:
					result = {
						content: [{ type: "text", text: `Unknown action: ${p.action}` }],
						details: { store: createLightSnapshot(store), action: p.action },
					};
			}

			// ── Granular Save ────────────────────────────────────
			if (MUTATING_ACTIONS.has(p.action)) {
				const singleTaskActions = new Set([
					"update", "set_status", "start", "complete", "block", "unblock",
					"add_note", "move_under", "promote", "flatten",
					"add_dependency", "remove_dependency",
					"assign_sprint", "unassign_sprint", "log_time",
				]);
				const singleSprintActions = new Set(["create_sprint", "start_sprint"]);

				if (singleTaskActions.has(p.action) && p.id !== undefined) {
					saveTaskFile(p.id);
				} else if (p.action === "create" && result.details?.store) {
					const newTask = store.tasks[store.tasks.length - 1];
					if (newTask && storage) storage.saveTask(newTask, store);
				} else if (p.action === "delete") {
					saveToFile();
				} else if (p.action === "complete_sprint") {
					const details = result.details as any;
					if (storage && details?.archivedTasks?.length > 0) {
						storage.archiveTasks(details.archivedTasks, store);
					}
					if (storage && details?.archivedSprint) {
						storage.archiveSprints([details.archivedSprint], store);
					}
					saveToFile();
				} else if (p.action === "archive") {
					saveToFile();
				} else if (singleSprintActions.has(p.action)) {
					const sprintId = p.id ?? store.sprints[store.sprints.length - 1]?.id;
					const sprint = store.sprints.find((s) => s.id === sprintId);
					if (sprint && storage) storage.saveSprint(sprint, store);
					else saveToFile();
				} else {
					saveToFile();
				}
			}

			// ── Event Emission ───────────────────────────────────
			if (MUTATING_ACTIONS.has(p.action) && !result.content[0]?.text?.startsWith("Error:")) {
				const targetTask = p.id !== undefined ? findTask(store, p.id) : undefined;
				switch (p.action) {
					case "create":
					case "bulk_create": {
						const newest = store.tasks[store.tasks.length - 1];
						if (newest) taskEvents.created(newest);
						break;
					}
					case "start":
						if (targetTask) taskEvents.statusChanged(targetTask, "todo", "in_progress");
						break;
					case "complete":
						if (targetTask) taskEvents.statusChanged(targetTask, "in_progress", "done");
						break;
					case "block":
						if (targetTask) taskEvents.statusChanged(targetTask, "in_progress", "blocked");
						break;
					case "unblock":
						if (targetTask) taskEvents.statusChanged(targetTask, "blocked", targetTask.status);
						break;
					case "set_status":
						if (targetTask && p.status) taskEvents.statusChanged(targetTask, "todo", p.status);
						break;
					case "delete": {
						const deleteText = result.content[0]?.text ?? "";
						const deleteMatch = deleteText.match(/Deleted #\d+:\s*(.+?)(?:\s*\(and|$)/);
						taskEvents.deleted(p.id ?? 0, deleteMatch?.[1]?.trim() ?? "");
						break;
					}
					case "add_note":
						if (targetTask) {
							const lastNote = targetTask.notes[targetTask.notes.length - 1];
							taskEvents.noteAdded(targetTask, lastNote?.text ?? "", lastNote?.author ?? "agent");
						}
						break;
					case "assign_sprint":
						if (targetTask && p.parentId !== undefined) {
							const sprint = store.sprints.find((s) => s.id === p.parentId);
							if (sprint) taskEvents.sprintAssigned(targetTask, sprint);
						}
						break;
				}
			}

			return result;
		},

		renderCall(args, theme) { return taskRenderCall(args, theme); },
		renderResult(result, options, theme) { return taskRenderResult(result, options, theme); },
	});

	// ─── Slash Commands ──────────────────────────────────────────

	registerTasksCommand(pi, getStore);
	registerTaskDetailCommand(pi, getStore);
	registerBoardCommand(pi as any, getStore, onUIMutate);
	registerTreeCommand(pi, getStore);
	registerSprintCommand(pi, getStore);
	registerExportCommand(pi, getStore);
	registerImportCommand(pi, getStore, onUIMutate);
	registerSyncCommand(
		pi, getStore,
		() => syncConfig,
		(c) => { syncConfig = c; },
		onUIMutate,
	);
	registerTaskHistoryCommand(pi, getStore);

	pi.registerCommand("archive", {
		description: "Archive done tasks and completed sprints to free the working set",
		handler: async (_args: string | undefined, ctx: ExtensionContext) => {
			const s = getStore();
			const r = archiveDoneTasks(s);
			saveToFile(ctx);
			refreshWidgets(ctx);
			ctx.ui.notify(r.content[0].text, "info");
		},
	});

	pi.registerCommand("automation", {
		description: "Toggle task automation: /automation [autostart|autocomplete|autonote] [on|off]",
		handler: async (args: string | undefined, ctx: ExtensionContext) => {
			if (!args?.trim()) {
				const lines = [
					`autostart:    ${automationConfig.autoStartOnFileEdit ? "on" : "off"}  (auto-start tasks on file edit)`,
					`autocomplete: ${automationConfig.autoCompleteOnTestPass ? "on" : "off"}  (suggest complete on test pass)`,
					`autonote:     ${automationConfig.autoNoteOnAgentEnd ? "on" : "off"}  (auto-add notes after agent turns)`,
				];
				ctx.ui.notify(`Task Automation:\n${lines.join("\n")}`, "info");
				return;
			}

			const [setting, value] = args.trim().split(/\s+/);
			const on = value !== "off";

			switch (setting) {
				case "autostart": automationConfig.autoStartOnFileEdit = on; break;
				case "autocomplete": automationConfig.autoCompleteOnTestPass = on; break;
				case "autonote": automationConfig.autoNoteOnAgentEnd = on; break;
				default: ctx.ui.notify(`Unknown setting: ${setting}`, "error"); return;
			}
			ctx.ui.notify(`${setting}: ${on ? "on" : "off"}`, "info");
		},
	});

	// ─── Keyboard Shortcuts ──────────────────────────────────────

	pi.registerShortcut(Key.ctrlShift("t"), {
		description: "Quick view task list",
		handler: async (ctx: ExtensionContext) => {
			const s = getStore();
			if (!ctx.hasUI) { ctx.ui.notify("Requires interactive mode", "error"); return; }
			if (s.tasks.length === 0) { ctx.ui.notify("No tasks yet.", "info"); return; }
			const { showTaskListOverlay } = await import("./commands/tasks-command.js");
			await showTaskListOverlay(s.tasks, ctx, s);
		},
	});

	pi.registerShortcut(Key.ctrlShift("b"), {
		description: "Open Kanban board",
		handler: async (ctx: ExtensionContext) => {
			const s = getStore();
			if (!ctx.hasUI) { ctx.ui.notify("Requires interactive mode", "error"); return; }
			if (s.tasks.length === 0) { ctx.ui.notify("No tasks yet.", "info"); return; }
			const { KanbanBoard } = await import("./ui/kanban-board.js");
			const { showTaskDetailOverlay } = await import("./commands/task-detail-command.js");

			const handleMutate = (action: any) => {
				if (action.type === "move") {
					ctx.ui.notify(`#${action.task.id}: ${action.oldStatus} → ${action.newStatus}`, "info");
				} else {
					ctx.ui.notify(`#${action.task.id}: priority ${action.oldPriority} → ${action.newPriority}`, "info");
				}
				onUIMutate();
			};

			let focusTaskId: number | undefined;
			while (true) {
				const result = await ctx.ui.custom<any>(
					(tui, theme, _kb, done) => new KanbanBoard(tui, s, theme, (r: any) => done(r), handleMutate, focusTaskId),
					{ overlay: true },
				);
				focusTaskId = undefined;
				if (!result) return;
				if (result.type === "detail") {
					const task = findTask(s, result.taskId);
					if (!task) continue;
					focusTaskId = task.id;
					const dr = await showTaskDetailOverlay(task, s, ctx);
					if (dr === "close") return;
					continue;
				}
			}
		},
	});

	pi.registerShortcut(Key.alt("t"), {
		description: "Toggle task widget collapse",
		handler: async (ctx: ExtensionContext) => {
			widgetCollapsed = !widgetCollapsed;
			updateNextTasksWidget(store, ctx, widgetCollapsed);
		},
	});
}
