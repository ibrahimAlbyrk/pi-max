/**
 * task tool — built-in task management with 37 actions.
 *
 * Two exports:
 * - taskToolDefinition: ToolDefinition for main agent (has renderCall/renderResult + ExtensionContext)
 * - createTaskTool(cwd): factory returning a plain AgentTool for subagents via tool registry
 *
 * Both share the same per-cwd TaskStore singleton within the Node.js process.
 */

import type { AgentTool } from "@mariozechner/pi-agent-core";
import { StringEnum } from "@mariozechner/pi-ai";
import { type Static, Type } from "@sinclair/typebox";
import type { ToolDefinition } from "../extensions/types.js";
import {
	handleBulkCreate,
	handleBulkDelete,
	handleBulkUpdate,
	handleCreate,
	handleDelete,
	handleGet,
	handleList,
	handleUpdate,
} from "../features/task/actions/crud.js";
import { handleAddNote } from "../features/task/actions/notes.js";
import {
	handleBlock,
	handleBulkSetStatus,
	handleComplete,
	handleSetStatus,
	handleStart,
	handleUnblock,
} from "../features/task/actions/status.js";
import {
	handleAddDependency,
	handleCheckDependencies,
	handleRemoveDependency,
} from "../features/task/dependencies/dep-ops.js";
import { generateFullExport } from "../features/task/export/full-export.js";
import { generateSummaryExport } from "../features/task/export/summary-export.js";
import {
	handleAssignGroup,
	handleCreateGroup,
	handleDeleteGroup,
	handleRenameGroup,
	handleTree,
	handleUnassignGroup,
} from "../features/task/hierarchy/tree-ops.js";
import { applyMerge, planMerge } from "../features/task/import/merge.js";
import { parseMarkdownTasks } from "../features/task/import/parser.js";
import { handleAnalyze } from "../features/task/intelligence/analyzer.js";
import { calculatePrioritySuggestions } from "../features/task/intelligence/prioritizer.js";
import { taskRenderCall } from "../features/task/rendering/call-renderer.js";
import { taskRenderResult } from "../features/task/rendering/result-renderer.js";
import {
	handleAssignSprint,
	handleBulkAssignSprint,
	handleCompleteSprint,
	handleCreateSprint,
	handleListSprints,
	handleLogTime,
	handleSprintStatus,
	handleStartSprint,
	handleUnassignSprint,
} from "../features/task/sprints/sprint-ops.js";
import { PerFileTaskStorage } from "../features/task/storage.js";
import { createLightSnapshot, recalculateNextIds } from "../features/task/store.js";
import type {
	TaskActionParams,
	TaskStorage,
	TaskStore,
	TaskToolDetails,
	TaskToolResult,
} from "../features/task/types.js";

// ── Parameter Schema ────────────────────────────────────────────────────────

const ALL_ACTIONS = [
	// CRUD
	"create",
	"get",
	"list",
	"update",
	"delete",
	// Status
	"set_status",
	"start",
	"complete",
	"block",
	"unblock",
	// Notes
	"add_note",
	// Bulk
	"bulk_create",
	"bulk_delete",
	"bulk_update",
	"bulk_set_status",
	"bulk_assign_sprint",
	// Groups
	"create_group",
	"delete_group",
	"rename_group",
	"assign_group",
	"unassign_group",
	"tree",
	// Dependencies
	"add_dependency",
	"remove_dependency",
	"check_dependencies",
	// Sprints
	"create_sprint",
	"start_sprint",
	"complete_sprint",
	"assign_sprint",
	"unassign_sprint",
	"sprint_status",
	"list_sprints",
	// Time
	"log_time",
	// Intelligence
	"analyze",
	"prioritize",
	// Export/Import
	"export",
	"import_text",
	// Archive
	"archive",
] as const;

export const TaskToolParams = Type.Object({
	action: StringEnum(ALL_ACTIONS),
	id: Type.Optional(Type.Number({ description: "Task or Sprint ID" })),
	ids: Type.Optional(
		Type.Array(Type.Number(), {
			description:
				"Multiple task IDs for bulk operations (bulk_delete, bulk_set_status, bulk_update, bulk_assign_sprint)",
		}),
	),
	title: Type.Optional(Type.String({ description: "Task/Sprint/Group title or name" })),
	description: Type.Optional(Type.String({ description: "Task/Sprint description" })),
	status: Type.Optional(StringEnum(["todo", "in_progress", "in_review", "blocked", "deferred", "done"] as const)),
	priority: Type.Optional(StringEnum(["critical", "high", "medium", "low"] as const)),
	tags: Type.Optional(Type.Array(Type.String(), { description: "Tags for categorization" })),
	parentId: Type.Optional(
		Type.Number({ description: "Dependency target ID, sprint ID, or group ID (context-dependent per action)" }),
	),
	groupId: Type.Optional(Type.Number({ description: "Task group ID for create/update/assign_group operations" })),
	assignee: Type.Optional(StringEnum(["user", "agent"] as const)),
	estimatedMinutes: Type.Optional(
		Type.Number({ description: "Estimated time in minutes, or minutes to log (log_time)" }),
	),
	text: Type.Optional(
		Type.String({ description: "Note text, block reason, analysis prompt, or markdown content (import_text)" }),
	),
	filterStatus: Type.Optional(
		StringEnum(["todo", "in_progress", "in_review", "blocked", "deferred", "done"] as const),
	),
	filterPriority: Type.Optional(StringEnum(["critical", "high", "medium", "low"] as const)),
	filterTag: Type.Optional(Type.String({ description: "Filter tasks by tag" })),
	filterGroupId: Type.Optional(Type.Number({ description: "Filter tasks by group ID" })),
	tasks: Type.Optional(
		Type.Array(
			Type.Object({
				title: Type.String(),
				description: Type.Optional(Type.String()),
				priority: Type.Optional(StringEnum(["critical", "high", "medium", "low"] as const)),
				tags: Type.Optional(Type.Array(Type.String())),
				parentId: Type.Optional(
					Type.Number({
						description:
							"Negative batch-internal ref: items with children become groups, children become tasks. -1=1st item, -2=2nd, etc.",
					}),
				),
				assignee: Type.Optional(StringEnum(["user", "agent"] as const)),
				estimatedMinutes: Type.Optional(Type.Number()),
			}),
			{
				description:
					"Array of tasks for bulk_create. Items with children (via parentId refs) auto-create groups for parent items.",
			},
		),
	),
});

export type TaskToolInput = Static<typeof TaskToolParams>;

// ── Per-cwd Store Singletons ────────────────────────────────────────────────

interface StoreEntry {
	store: TaskStore;
	storage: TaskStorage;
}

const _storeMap = new Map<string, StoreEntry>();

/** Callback invoked after any mutating tool action. Used by feature setup to refresh widget. */
let _onStoreChanged: (() => void) | null = null;

/** Register a callback to be notified when the tool mutates the store. */
export function setOnStoreChanged(callback: (() => void) | null): void {
	_onStoreChanged = callback;
}

function getStoreEntry(cwd: string): StoreEntry {
	let entry = _storeMap.get(cwd);
	if (!entry) {
		const storage = new PerFileTaskStorage(cwd);
		const store = storage.load();
		entry = { store, storage };
		_storeMap.set(cwd, entry);
	}
	return entry;
}

// ── Mutating Action Sets (for save strategy) ────────────────────────────────

const MUTATING_ACTIONS = new Set([
	"create",
	"update",
	"delete",
	"set_status",
	"start",
	"complete",
	"block",
	"unblock",
	"add_note",
	"bulk_create",
	"bulk_delete",
	"bulk_update",
	"bulk_set_status",
	"bulk_assign_sprint",
	"create_group",
	"delete_group",
	"rename_group",
	"assign_group",
	"unassign_group",
	"add_dependency",
	"remove_dependency",
	"create_sprint",
	"start_sprint",
	"complete_sprint",
	"assign_sprint",
	"unassign_sprint",
	"log_time",
	"import_text",
	"archive",
]);

const SINGLE_TASK_ACTIONS = new Set([
	"update",
	"set_status",
	"start",
	"complete",
	"block",
	"unblock",
	"add_note",
	"assign_group",
	"unassign_group",
	"add_dependency",
	"remove_dependency",
	"assign_sprint",
	"unassign_sprint",
	"log_time",
]);

const SINGLE_SPRINT_ACTIONS = new Set(["create_sprint", "start_sprint"]);

// ── Archive Helper ──────────────────────────────────────────────────────────

function archiveDoneTasks(store: TaskStore, storage: TaskStorage): TaskToolResult {
	const activeSprintIds = new Set(store.sprints.filter((sp) => sp.status !== "completed").map((sp) => sp.id));
	const tasksToArchive = store.tasks.filter(
		(t) => t.status === "done" && (t.sprintId === null || !activeSprintIds.has(t.sprintId)),
	);
	const sprintsToArchive = store.sprints.filter((sp) => sp.status === "completed");

	if (tasksToArchive.length === 0 && sprintsToArchive.length === 0) {
		return {
			content: [{ type: "text", text: "Nothing to archive — no done tasks or completed sprints." }],
			details: { store: createLightSnapshot(store), action: "archive" },
		};
	}

	const archivedTaskIds = new Set(tasksToArchive.map((t) => t.id));
	const archivedSprintIds = new Set(sprintsToArchive.map((sp) => sp.id));

	if (tasksToArchive.length > 0) storage.archiveTasks(tasksToArchive, store);
	if (sprintsToArchive.length > 0) storage.archiveSprints(sprintsToArchive, store);

	store.tasks = store.tasks.filter((t) => !archivedTaskIds.has(t.id));
	store.sprints = store.sprints.filter((sp) => !archivedSprintIds.has(sp.id));

	if (store.activeTaskId !== null && archivedTaskIds.has(store.activeTaskId)) {
		store.activeTaskId = null;
	}

	recalculateNextIds(store);

	const lines: string[] = [];
	if (tasksToArchive.length > 0) {
		lines.push(`Archived ${tasksToArchive.length} done task(s): ${tasksToArchive.map((t) => `#${t.id}`).join(", ")}`);
	}
	if (sprintsToArchive.length > 0) {
		lines.push(
			`Archived ${sprintsToArchive.length} completed sprint(s): ${sprintsToArchive.map((sp) => `#S${sp.id}`).join(", ")}`,
		);
	}
	lines.push(`Active: ${store.tasks.length} tasks, ${store.sprints.length} sprints remaining.`);

	return {
		content: [{ type: "text", text: lines.join("\n") }],
		details: { store: createLightSnapshot(store), action: "archive" },
	};
}

// ── Shared dispatch + save ──────────────────────────────────────────────────

function executeTaskAction(params: TaskToolInput, cwd: string): TaskToolResult {
	const { store, storage } = getStoreEntry(cwd);
	const p = params as TaskActionParams;
	let result: TaskToolResult;

	// ── Action Dispatch ────────────────────────────────────────
	switch (p.action) {
		case "create":
			result = handleCreate(store, p);
			break;
		case "get":
			result = handleGet(store, p);
			break;
		case "list":
			result = handleList(store, p);
			break;
		case "update":
			result = handleUpdate(store, p);
			break;
		case "delete":
			result = handleDelete(store, p);
			break;
		case "set_status":
			result = handleSetStatus(store, p);
			break;
		case "start":
			result = handleStart(store, p);
			break;
		case "complete":
			result = handleComplete(store, p);
			break;
		case "block":
			result = handleBlock(store, p);
			break;
		case "unblock":
			result = handleUnblock(store, p);
			break;
		case "add_note":
			result = handleAddNote(store, p);
			break;
		case "bulk_create":
			result = handleBulkCreate(store, p);
			break;
		case "bulk_delete":
			result = handleBulkDelete(store, p);
			break;
		case "bulk_update":
			result = handleBulkUpdate(store, p);
			break;
		case "bulk_set_status":
			result = handleBulkSetStatus(store, p);
			break;
		case "bulk_assign_sprint":
			result = handleBulkAssignSprint(store, p);
			break;
		case "create_group":
			result = handleCreateGroup(store, p);
			break;
		case "delete_group":
			result = handleDeleteGroup(store, p);
			break;
		case "rename_group":
			result = handleRenameGroup(store, p);
			break;
		case "assign_group":
			result = handleAssignGroup(store, p);
			break;
		case "unassign_group":
			result = handleUnassignGroup(store, p);
			break;
		case "tree":
			result = handleTree(store, p);
			break;
		case "add_dependency":
			result = handleAddDependency(store, p);
			break;
		case "remove_dependency":
			result = handleRemoveDependency(store, p);
			break;
		case "check_dependencies":
			result = handleCheckDependencies(store, p);
			break;
		case "create_sprint":
			result = handleCreateSprint(store, p);
			break;
		case "start_sprint":
			result = handleStartSprint(store, p);
			break;
		case "complete_sprint":
			result = handleCompleteSprint(store, p);
			break;
		case "assign_sprint":
			result = handleAssignSprint(store, p);
			break;
		case "unassign_sprint":
			result = handleUnassignSprint(store, p);
			break;
		case "sprint_status":
			result = handleSprintStatus(store, p);
			break;
		case "list_sprints":
			result = handleListSprints(store, p);
			break;
		case "log_time":
			result = handleLogTime(store, p);
			break;
		case "archive":
			result = archiveDoneTasks(store, storage);
			break;
		case "analyze":
			result = handleAnalyze(store, p.text);
			break;
		case "prioritize": {
			const suggestions = calculatePrioritySuggestions(store);
			if (suggestions.length === 0) {
				result = {
					content: [{ type: "text", text: "No priority changes suggested — current priorities look reasonable." }],
					details: { store: createLightSnapshot(store), action: "prioritize" },
				};
			} else {
				const lines = suggestions.map(
					(s) => `#${s.taskId} (${s.title}): ${s.currentPriority} → ${s.suggestedPriority} — ${s.reason}`,
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
			const content = fmt === "summary" ? generateSummaryExport(store) : generateFullExport(store);
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
					content: [
						{
							type: "text",
							text: "No markdown content provided. Use text parameter with markdown task content.",
						},
					],
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
				content: [
					{
						type: "text",
						text: `Imported: ${mResult.created} new, ${mResult.updated} updated from markdown text.`,
					},
				],
				details: { store: createLightSnapshot(store), action: "import_text" },
			};
			break;
		}
		default: {
			result = {
				content: [{ type: "text", text: `Unknown action: ${p.action}` }],
				details: { store: createLightSnapshot(store), action: p.action },
			};
		}
	}

	// ── Granular Save Strategy ─────────────────────────────────
	if (MUTATING_ACTIONS.has(p.action) && !result.content[0]?.text?.startsWith("Error:")) {
		if (SINGLE_TASK_ACTIONS.has(p.action) && p.id !== undefined) {
			const task = store.tasks.find((t) => t.id === p.id);
			if (task) {
				storage.saveTask(task, store);
				storage.saveIndex(store);
			} else {
				storage.save(store);
			}
		} else if (p.action === "create") {
			const newTask = store.tasks[store.tasks.length - 1];
			if (newTask) {
				storage.saveTask(newTask, store);
				storage.saveIndex(store);
			}
		} else if (p.action === "complete_sprint") {
			const details = result.details as TaskToolDetails;
			if (details.archivedTasks && details.archivedTasks.length > 0) {
				storage.archiveTasks(details.archivedTasks, store);
			}
			if (details.archivedSprint) {
				storage.archiveSprints([details.archivedSprint], store);
			}
			storage.save(store);
		} else if (p.action === "archive") {
			// archive already wrote files directly via archiveDoneTasks; just save the index
			storage.saveIndex(store);
		} else if (SINGLE_SPRINT_ACTIONS.has(p.action)) {
			const sprintId = p.id ?? store.sprints[store.sprints.length - 1]?.id;
			const sprint = sprintId !== undefined ? store.sprints.find((s) => s.id === sprintId) : undefined;
			if (sprint) {
				storage.saveSprint(sprint, store);
				storage.saveIndex(store);
			} else {
				storage.save(store);
			}
		} else if (p.action === "create_group") {
			const newGroup = store.groups[store.groups.length - 1];
			if (newGroup) {
				storage.saveGroup(newGroup, store);
				storage.saveIndex(store);
			} else {
				storage.save(store);
			}
		} else if (p.action === "rename_group" && p.id !== undefined) {
			const group = store.groups.find((g) => g.id === p.id);
			if (group) {
				storage.saveGroup(group, store);
				storage.saveIndex(store);
			} else {
				storage.save(store);
			}
		} else {
			// Bulk ops, delete, delete_group, bulk_create, import_text, etc.
			storage.save(store);
		}

		// Notify feature setup to refresh widget
		_onStoreChanged?.();
	}

	return result;
}

// ── Tool Description ─────────────────────────────────────────────────────────

const TOOL_DESCRIPTION = `Structured project task management. Tasks persist per-project across sessions in .pi/tasks/.

## Workflow — ALWAYS follow this pattern:
1. PLAN first: Break work into discrete, trackable tasks BEFORE writing code.
2. CREATE tasks in bulk: Use bulk_create with text param (compact format, ~5x faster than JSON):
   bulk_create text="Group Name [high] #backend\\n  Task A [high] @agent ~30m\\n  Task B"
   Rules: indent=hierarchy (top-level with children become groups), [priority], #tag, @assignee, ~time, > description line
3. START a task: Call start before working on it (sets active context).
4. WORK on it: Write code, run tests — one task at a time.
5. COMPLETE it: Call complete when done, then start the next.

## Task Groups:
- Groups (G1, G2, ...) are organizational containers — they have NO status and cannot be started/completed.
- Tasks (#1, #2, ...) are always actionable work items — every task can be started and completed.
- Use groups to organize related tasks (e.g., "Backend API", "Authentication").
- Progress is shown per group: "G1 Backend API (3/5 done)".

## Actions Reference:
CRUD: create, get, list, update, delete, bulk_create
Bulk: bulk_delete (ids), bulk_set_status (ids+status), bulk_update (ids+fields), bulk_assign_sprint (ids+parentId)
Status: set_status, start, complete, block (id+text=reason), unblock
Groups: create_group (title), delete_group (id), rename_group (id+title), assign_group (id+groupId), unassign_group (id), tree
Dependencies: add_dependency (id depends on parentId), remove_dependency (id+parentId), check_dependencies (id)
Sprints: create_sprint (title), start_sprint (id), complete_sprint (id), assign_sprint (id=task, parentId=sprint), unassign_sprint (id), sprint_status ([id]), list_sprints
Time: log_time (id, estimatedMinutes=minutes to add), add_note (id, text, [assignee=user|agent])
Intelligence: analyze ([text=prompt]), prioritize
Export: export ([text=summary|full]), import_text (text=markdown content to parse and import)
Archive: archive (move done tasks + completed sprints to archive, keeps working set clean)

## Bulk Operations — 3 targeting modes (pick one):
1. **ids array**: bulk_delete ids=[1,2,3] — specific tasks
2. **filters**: bulk_delete filterStatus="done" — matching tasks
3. **nothing**: bulk_delete — ALL tasks

Examples:
  task create title="Fix login bug" priority="high" tags=["auth"]
  task bulk_create text="Auth\\n  Login flow [high] @agent ~30m\\n  Token refresh [medium] ~15m"
  task start id=1
  task complete id=1
  task block id=2 text="Waiting for API spec"
  task list filterStatus="in_progress"
  task tree
  task create_group title="Backend" description="Server-side tasks"
  task add_dependency id=3 parentId=1
  task create_sprint title="Sprint 1"
  task start_sprint id=1
  task assign_sprint id=3 parentId=1
  task sprint_status
  task log_time id=3 estimatedMinutes=45
  task bulk_set_status filterStatus="todo" status="in_progress"
  task bulk_assign_sprint filterStatus="todo" parentId=1
  task export text="summary"
  task archive
  task prioritize`;

// ── Tool Definition (main agent — includes renderCall/renderResult) ──────────

export const taskToolDefinition: ToolDefinition<typeof TaskToolParams, TaskToolDetails> = {
	name: "task",
	label: "Task Manager",
	description: TOOL_DESCRIPTION,
	parameters: TaskToolParams,

	async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		return executeTaskAction(params, ctx.cwd);
	},

	renderCall(args, _options, theme) {
		return taskRenderCall(args as Record<string, unknown>, theme);
	},

	renderResult(result, options, theme) {
		return taskRenderResult(result, options, theme);
	},
};

// ── Factory (subagents via tool registry — plain AgentTool) ────────────────

export function createTaskTool(cwd: string): AgentTool<typeof TaskToolParams> {
	return {
		name: "task",
		label: "task",
		sideEffects: true,
		description: TOOL_DESCRIPTION,
		parameters: TaskToolParams,

		async execute(_toolCallId, params, _signal, _onUpdate) {
			return executeTaskAction(params, cwd);
		},
	};
}

// ── Store access (for commands module) ──────────────────────────────────────

/** Get the TaskStore for a given cwd. Used by command registration module. */
export function getTaskStore(cwd: string): TaskStore {
	return getStoreEntry(cwd).store;
}

/** Get the TaskStorage for a given cwd. Used by command registration module. */
export function getTaskStorage(cwd: string): TaskStorage {
	return getStoreEntry(cwd).storage;
}

/**
 * Synchronize the tool's store entry with an externally-managed store and storage.
 * Called by features/task/index.ts so that the feature setup and tool share
 * the SAME in-memory store instance. Without this, mutations made by feature
 * hooks (e.g., subagent:tasks-assigned) would not be visible to the tool/commands/widget.
 */
export function _syncToolStore(cwd: string, store: TaskStore, storage: TaskStorage): void {
	_storeMap.set(cwd, { store, storage });
}

// ── Reset singleton (for testing) ───────────────────────────────────────────

export function _resetTaskStoreForTesting(cwd: string): void {
	_storeMap.delete(cwd);
}

export function _resetAllTaskStoresForTesting(): void {
	_storeMap.clear();
}
