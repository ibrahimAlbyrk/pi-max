/**
 * Group & Tree Operations — create_group, delete_group, rename_group, assign_group, unassign_group, tree
 */

import type { TaskStore, TaskActionParams, TaskToolResult } from "../types.js";
import { findTask, findGroup, getGroupTasks, createGroup, recalculateNextIds } from "../store.js";
import { toolResult as result, toolError as error } from "../utils/response.js";

// ─── Create Group ────────────────────────────────────────────────

export function handleCreateGroup(store: TaskStore, params: TaskActionParams): TaskToolResult {
	if (!params.title?.trim()) {
		return error(store, "create_group", "Group name (title) is required");
	}

	const group = createGroup(store, params.title.trim(), params.description ?? "");
	store.groups.push(group);
	store.nextGroupId++;

	return result(store, "create_group", `Created group G${group.id}: ${group.name}`);
}

// ─── Delete Group ────────────────────────────────────────────────

export function handleDeleteGroup(store: TaskStore, params: TaskActionParams): TaskToolResult {
	if (params.id === undefined) {
		return error(store, "delete_group", "Group ID is required");
	}

	const group = findGroup(store, params.id);
	if (!group) {
		return error(store, "delete_group", `Group G${params.id} not found`);
	}

	// Unassign all tasks in this group (they become ungrouped, not deleted)
	const groupTasks = getGroupTasks(store, group.id);
	for (const task of groupTasks) {
		task.groupId = null;
	}

	store.groups = store.groups.filter((g) => g.id !== group.id);
	recalculateNextIds(store);

	const unassignedMsg = groupTasks.length > 0
		? ` (${groupTasks.length} task(s) moved to ungrouped)`
		: "";

	return result(store, "delete_group", `Deleted group G${group.id}: ${group.name}${unassignedMsg}`);
}

// ─── Rename Group ────────────────────────────────────────────────

export function handleRenameGroup(store: TaskStore, params: TaskActionParams): TaskToolResult {
	if (params.id === undefined) {
		return error(store, "rename_group", "Group ID is required");
	}
	if (!params.title?.trim()) {
		return error(store, "rename_group", "New name (title) is required");
	}

	const group = findGroup(store, params.id);
	if (!group) {
		return error(store, "rename_group", `Group G${params.id} not found`);
	}

	const oldName = group.name;
	group.name = params.title.trim();
	if (params.description !== undefined) {
		group.description = params.description;
	}

	return result(store, "rename_group", `Renamed group G${group.id}: "${oldName}" → "${group.name}"`);
}

// ─── Assign Group ────────────────────────────────────────────────

export function handleAssignGroup(store: TaskStore, params: TaskActionParams): TaskToolResult {
	if (params.id === undefined) {
		return error(store, "assign_group", "Task ID is required");
	}
	if (params.parentId === undefined && params.groupId === undefined) {
		return error(store, "assign_group", "Group ID (groupId or parentId) is required");
	}

	const task = findTask(store, params.id);
	if (!task) {
		return error(store, "assign_group", `Task #${params.id} not found`);
	}

	const targetGroupId = params.groupId ?? params.parentId!;
	const group = findGroup(store, targetGroupId);
	if (!group) {
		return error(store, "assign_group", `Group G${targetGroupId} not found`);
	}

	const oldGroupId = task.groupId;
	task.groupId = group.id;

	const fromStr = oldGroupId !== null
		? `G${oldGroupId}`
		: "ungrouped";

	return result(store, "assign_group", `#${task.id} moved to G${group.id} (${group.name}) from ${fromStr}`);
}

// ─── Unassign Group ──────────────────────────────────────────────

export function handleUnassignGroup(store: TaskStore, params: TaskActionParams): TaskToolResult {
	if (params.id === undefined) {
		return error(store, "unassign_group", "Task ID is required");
	}

	const task = findTask(store, params.id);
	if (!task) {
		return error(store, "unassign_group", `Task #${params.id} not found`);
	}

	if (task.groupId === null) {
		return error(store, "unassign_group", `Task #${task.id} is not in any group`);
	}

	const oldGroupId = task.groupId;
	const group = findGroup(store, oldGroupId);
	task.groupId = null;

	return result(store, "unassign_group", `#${task.id} removed from G${oldGroupId}${group ? ` (${group.name})` : ""}`);
}

// ─── Tree View ───────────────────────────────────────────────────

export function handleTree(store: TaskStore, _params: TaskActionParams): TaskToolResult {
	if (store.tasks.length === 0 && store.groups.length === 0) {
		return result(store, "tree", "No tasks or groups");
	}

	const lines = renderTreeText(store);
	return result(store, "tree", lines.join("\n"));
}

export function renderTreeText(store: TaskStore): string[] {
	const lines: string[] = [];

	// Render groups with their tasks
	for (const group of store.groups) {
		const tasks = getGroupTasks(store, group.id);
		const doneCount = tasks.filter((t) => t.status === "done").length;
		const progressStr = tasks.length > 0 ? ` (${doneCount}/${tasks.length} done)` : " (empty)";

		lines.push(`◆ G${group.id} ${group.name}${progressStr}`);

		for (let i = 0; i < tasks.length; i++) {
			const task = tasks[i];
			const isLast = i === tasks.length - 1;
			const connector = isLast ? "└── " : "├── ";
			const statusIcon = getStatusIcon(task.status);
			const pri = task.priority[0].toUpperCase();

			lines.push(`   ${connector}${statusIcon} #${task.id} [${pri}] ${task.title}  ${task.status}`);
		}
	}

	// Render ungrouped tasks
	const ungrouped = store.tasks.filter((t) => t.groupId === null);
	if (ungrouped.length > 0) {
		if (store.groups.length > 0) {
			lines.push("");
			lines.push("(ungrouped)");
		}
		for (const task of ungrouped) {
			const statusIcon = getStatusIcon(task.status);
			const pri = task.priority[0].toUpperCase();
			lines.push(`${statusIcon} #${task.id} [${pri}] ${task.title}  ${task.status}`);
		}
	}

	return lines;
}

function getStatusIcon(status: string): string {
	switch (status) {
		case "done": return "✓";
		case "in_progress": return "●";
		case "blocked": return "⊘";
		default: return "○";
	}
}
