/**
 * Sprint Operations — CRUD, lifecycle, assignment, stats
 *
 * Migrated from .pi/extensions/task-management/sprints/sprint-ops.ts
 *
 * Sprint lifecycle: planned → active → completed
 * Only one active sprint at a time; starting a new sprint auto-completes the previous one.
 */

import { findTask, formatElapsed, recalculateNextIds } from "../store.js";
import type { Sprint, TaskActionParams, TaskStore, TaskToolResult } from "../types.js";
import { formatDateShort as formatDate } from "../ui/helpers.js";
import { getMissingIds, resolveBulkTargets } from "../utils/bulk-targets.js";
import { bulkResult, toolError as error, toolResult as result } from "../utils/response.js";

// ─── Create Sprint ───────────────────────────────────────────────

export function handleCreateSprint(store: TaskStore, params: TaskActionParams): TaskToolResult {
	if (!params.title?.trim()) {
		return error(store, "create_sprint", "Sprint name (title) is required");
	}

	const sprint: Sprint = {
		id: store.nextSprintId,
		name: params.title.trim(),
		description: params.description ?? "",
		status: "planned",
		startDate: null,
		endDate: null,
		completedDate: null,
		createdAt: new Date().toISOString(),
	};

	store.sprints.push(sprint);
	store.nextSprintId++;

	return result(store, "create_sprint", `Created sprint #S${sprint.id}: ${sprint.name} (planned)`);
}

// ─── Start Sprint ────────────────────────────────────────────────

export function handleStartSprint(store: TaskStore, params: TaskActionParams): TaskToolResult {
	if (params.id === undefined) {
		return error(store, "start_sprint", "Sprint ID is required");
	}

	const sprint = store.sprints.find((s) => s.id === params.id);
	if (!sprint) return error(store, "start_sprint", `Sprint #S${params.id} not found`);

	if (sprint.status === "active") {
		return error(store, "start_sprint", `Sprint #S${sprint.id} is already active`);
	}

	// Auto-complete the previous active sprint before starting the new one
	const activeSprint = store.sprints.find((s) => s.status === "active");
	if (activeSprint) {
		activeSprint.status = "completed";
		activeSprint.completedDate = new Date().toISOString();
	}

	sprint.status = "active";
	sprint.startDate = new Date().toISOString();
	store.activeSprintId = sprint.id;

	let text = `Started sprint #S${sprint.id}: ${sprint.name}`;
	if (activeSprint) {
		text += `\nPrevious sprint #S${activeSprint.id} (${activeSprint.name}) auto-completed.`;
	}

	return result(store, "start_sprint", text);
}

// ─── Complete Sprint ─────────────────────────────────────────────

export function handleCompleteSprint(store: TaskStore, params: TaskActionParams): TaskToolResult {
	if (params.id === undefined) {
		return error(store, "complete_sprint", "Sprint ID is required");
	}

	const sprint = store.sprints.find((s) => s.id === params.id);
	if (!sprint) return error(store, "complete_sprint", `Sprint #S${params.id} not found`);

	if (sprint.status === "completed") {
		return error(store, "complete_sprint", `Sprint #S${sprint.id} is already completed`);
	}

	const sprintTasks = store.tasks.filter((t) => t.sprintId === sprint.id);
	const unfinished = sprintTasks.filter((t) => t.status !== "done");
	const doneTasks = sprintTasks.filter((t) => t.status === "done");

	sprint.status = "completed";
	sprint.completedDate = new Date().toISOString();

	if (store.activeSprintId === sprint.id) {
		store.activeSprintId = null;
	}

	// Auto-archive done tasks from this sprint; remove them from the active store
	const archivedIds: number[] = doneTasks.map((t) => t.id);
	if (archivedIds.length > 0) {
		store.tasks = store.tasks.filter((t) => !archivedIds.includes(t.id));
	}

	recalculateNextIds(store);

	const doneCount = sprintTasks.length - unfinished.length;
	let text = `Completed sprint #S${sprint.id}: ${sprint.name}`;
	text += `\nCompleted: ${doneCount}/${sprintTasks.length} tasks`;

	if (archivedIds.length > 0) {
		text += `\nArchived ${archivedIds.length} done task(s): ${archivedIds.map((id) => `#${id}`).join(", ")}`;
	}

	if (unfinished.length > 0) {
		text += `\nWarning: ${unfinished.length} unfinished task(s): ${unfinished.map((t) => `#${t.id}`).join(", ")}`;
		text += `\nConsider assigning them to the next sprint.`;
	}

	const res = result(store, "complete_sprint", text);
	// Pass archived data through details so the tool dispatcher can persist to storage
	res.details.archivedTasks = doneTasks;
	res.details.archivedSprint = sprint;
	return res;
}

// ─── Assign Sprint ───────────────────────────────────────────────

export function handleAssignSprint(store: TaskStore, params: TaskActionParams): TaskToolResult {
	if (params.id === undefined) {
		return error(store, "assign_sprint", "Task ID is required");
	}

	// parentId is reused as the sprint ID for this action
	const sprintId = params.parentId;
	if (sprintId === undefined) {
		return error(store, "assign_sprint", "Sprint ID (parentId field) is required");
	}

	const task = findTask(store, params.id);
	if (!task) return error(store, "assign_sprint", `Task #${params.id} not found`);

	const sprint = store.sprints.find((s) => s.id === sprintId);
	if (!sprint) return error(store, "assign_sprint", `Sprint #S${sprintId} not found`);

	task.sprintId = sprintId;
	return result(store, "assign_sprint", `#${task.id} assigned to sprint #S${sprint.id} (${sprint.name})`);
}

// ─── Unassign Sprint ─────────────────────────────────────────────

export function handleUnassignSprint(store: TaskStore, params: TaskActionParams): TaskToolResult {
	if (params.id === undefined) {
		return error(store, "unassign_sprint", "Task ID is required");
	}

	const task = findTask(store, params.id);
	if (!task) return error(store, "unassign_sprint", `Task #${params.id} not found`);

	if (task.sprintId === null) {
		return error(store, "unassign_sprint", `Task #${params.id} is not assigned to any sprint`);
	}

	const oldSprintId = task.sprintId;
	task.sprintId = null;
	return result(store, "unassign_sprint", `#${task.id} removed from sprint #S${oldSprintId}`);
}

// ─── Sprint Status ───────────────────────────────────────────────

export function handleSprintStatus(store: TaskStore, params: TaskActionParams): TaskToolResult {
	const sprintId = params.id ?? store.activeSprintId;
	if (sprintId === null || sprintId === undefined) {
		return error(store, "sprint_status", "No active sprint. Provide a sprint ID or start a sprint first.");
	}

	const sprint = store.sprints.find((s) => s.id === sprintId);
	if (!sprint) return error(store, "sprint_status", `Sprint #S${sprintId} not found`);

	const tasks = store.tasks.filter((t) => t.sprintId === sprint.id);
	const done = tasks.filter((t) => t.status === "done").length;
	const inProgress = tasks.filter((t) => t.status === "in_progress").length;
	const todo = tasks.filter((t) => t.status === "todo").length;
	const blocked = tasks.filter((t) => t.status === "blocked").length;
	const total = tasks.length;
	const pct = total > 0 ? Math.round((done / total) * 100) : 0;

	const barLen = 20;
	const filled = Math.round((done / Math.max(total, 1)) * barLen);
	const bar = "█".repeat(filled) + "░".repeat(barLen - filled);

	const lines: string[] = [];
	lines.push(`Sprint #S${sprint.id}: ${sprint.name}`);
	lines.push(`Status: ${sprint.status} | Started: ${sprint.startDate ? formatDate(sprint.startDate) : "not started"}`);
	lines.push(`Progress: ${bar} ${done}/${total} (${pct}%)`);
	lines.push("");
	lines.push(`  Done: ${done}  In Progress: ${inProgress}  Todo: ${todo}  Blocked: ${blocked}`);

	// Velocity — avg actual time per completed task
	const doneTasks = tasks.filter((t) => t.status === "done" && t.actualMinutes !== null);
	if (doneTasks.length > 0) {
		const totalMinutes = doneTasks.reduce((s, t) => s + (t.actualMinutes ?? 0), 0);
		const avgMinutes = Math.round(totalMinutes / doneTasks.length);
		lines.push(`\n  Avg time per task: ${formatElapsed(avgMinutes * 60000)}`);

		const remaining = total - done;
		if (remaining > 0) {
			const remainingMinutes = remaining * avgMinutes;
			lines.push(`  ETA for remaining: ~${formatElapsed(remainingMinutes * 60000)}`);
		}
	}

	return result(store, "sprint_status", lines.join("\n"));
}

// ─── List Sprints ────────────────────────────────────────────────

export function handleListSprints(store: TaskStore, _params: TaskActionParams): TaskToolResult {
	if (store.sprints.length === 0) {
		return result(store, "list_sprints", "No sprints yet");
	}

	const lines: string[] = [`${store.sprints.length} sprint(s):`];
	for (const s of store.sprints) {
		const tasks = store.tasks.filter((t) => t.sprintId === s.id);
		const done = tasks.filter((t) => t.status === "done").length;
		const icon = s.status === "active" ? ">" : s.status === "completed" ? "v" : "o";
		lines.push(`  [${icon}] #S${s.id} ${s.name} (${s.status}) — ${done}/${tasks.length} tasks done`);
	}

	return result(store, "list_sprints", lines.join("\n"));
}

// ─── Log Time ────────────────────────────────────────────────────

export function handleLogTime(store: TaskStore, params: TaskActionParams): TaskToolResult {
	if (params.id === undefined) {
		return error(store, "log_time", "Task ID is required");
	}
	if (params.estimatedMinutes === undefined) {
		return error(store, "log_time", "Minutes (estimatedMinutes field) is required");
	}

	const task = findTask(store, params.id);
	if (!task) return error(store, "log_time", `Task #${params.id} not found`);

	task.actualMinutes = (task.actualMinutes ?? 0) + params.estimatedMinutes;

	return result(
		store,
		"log_time",
		`Logged ${params.estimatedMinutes}m to #${task.id} (total: ${task.actualMinutes}m)`,
	);
}

// ─── Bulk Assign Sprint ──────────────────────────────────────────
//
// Assign multiple tasks to a sprint. Target selection:
//   - Explicit ids array → only those tasks
//   - Filter params (filterStatus, filterPriority, filterTag, filterGroupId) → matching tasks
//   - Neither → ALL tasks (see spec section 17.5)

export function handleBulkAssignSprint(store: TaskStore, params: TaskActionParams): TaskToolResult {
	// parentId is reused as the sprint ID for this action
	const sprintId = params.parentId;
	if (sprintId === undefined) {
		return error(store, "bulk_assign_sprint", "Sprint ID (parentId field) is required");
	}

	const sprint = store.sprints.find((s) => s.id === sprintId);
	if (!sprint) return error(store, "bulk_assign_sprint", `Sprint #S${sprintId} not found`);

	const { tasks: targets, selectionLabel } = resolveBulkTargets(store, params);

	if (targets.length === 0) {
		return error(store, "bulk_assign_sprint", `No tasks found (${selectionLabel})`);
	}

	const assigned: { id: number; title: string }[] = [];
	const skipped: { id: number; reason: string }[] = [];

	for (const task of targets) {
		if (task.sprintId === sprintId) {
			skipped.push({ id: task.id, reason: `already in #S${sprintId}` });
			continue;
		}

		task.sprintId = sprintId;
		assigned.push({ id: task.id, title: task.title });
	}

	if (assigned.length === 0) {
		const reasons = skipped.map((s) => `#${s.id}: ${s.reason}`);
		return error(store, "bulk_assign_sprint", `No tasks assigned (${selectionLabel}).\n${reasons.join("\n")}`);
	}

	const notFound = getMissingIds(store, params);
	const lines = [`${assigned.length} task(s) → sprint #S${sprint.id} (${sprint.name}) (${selectionLabel}):`];
	for (const a of assigned) {
		lines.push(`  + #${a.id} ${a.title}`);
	}
	if (skipped.length > 0) {
		lines.push(`Skipped: ${skipped.map((s) => `#${s.id} (${s.reason})`).join(", ")}`);
	}
	if (notFound.length > 0) {
		lines.push(`Not found: ${notFound.map((id) => `#${id}`).join(", ")}`);
	}

	return bulkResult(
		store,
		"bulk_assign_sprint",
		lines.join("\n"),
		assigned.map((a) => a.id),
	);
}
