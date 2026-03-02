/**
 * Hierarchy Operations — move_under, promote, flatten, cycle detection
 */

import type { TaskStore, TaskActionParams, TaskToolResult } from "../types.js";
import { findTask, isGroupContainer, updateAncestorStatuses } from "../store.js";
import { toolResult as result, toolError as error } from "../utils/response.js";

// ─── Cycle Detection ─────────────────────────────────────────────

export function detectParentCycle(store: TaskStore, taskId: number, newParentId: number): boolean {
	let current: number | null = newParentId;
	while (current !== null) {
		if (current === taskId) return true;
		const parent = store.tasks.find((t) => t.id === current);
		current = parent?.parentId ?? null;
	}
	return false;
}

// ─── Move Under ──────────────────────────────────────────────────

export function handleMoveUnder(store: TaskStore, params: TaskActionParams): TaskToolResult {
	if (params.id === undefined) {
		return error(store, "move_under", "Task ID is required");
	}
	if (params.parentId === undefined) {
		return error(store, "move_under", "Parent task ID (parentId) is required");
	}

	const task = findTask(store, params.id);
	if (!task) return error(store, "move_under", `Task #${params.id} not found`);

	// Allow parentId = 0 or null to make top-level
	if (params.parentId === 0 || params.parentId === null) {
		const oldParentId = task.parentId;
		task.parentId = null;
		// Re-derive old parent (may have lost last child → demoted to leaf)
		if (oldParentId !== null) updateAncestorStatuses(store, oldParentId);
		return result(store, "move_under", `#${task.id} moved to top level (was under ${oldParentId !== null ? `#${oldParentId}` : "top level"})`);
	}

	const parent = findTask(store, params.parentId);
	if (!parent) return error(store, "move_under", `Parent task #${params.parentId} not found`);

	if (params.id === params.parentId) {
		return error(store, "move_under", "Cannot move a task under itself");
	}

	if (detectParentCycle(store, params.id, params.parentId)) {
		return error(store, "move_under", `Cycle detected: #${params.parentId} is a descendant of #${params.id}`);
	}

	const oldParentId = task.parentId;
	task.parentId = params.parentId;

	// Re-derive old parent (may have lost last child → demoted to leaf)
	if (oldParentId !== null) updateAncestorStatuses(store, oldParentId);
	// Re-derive new parent (new child changes derived status)
	updateAncestorStatuses(store, params.parentId);

	const text = `#${task.id} moved under #${params.parentId} (${parent.title})`;

	return result(store, "move_under", text);
}

// ─── Promote ─────────────────────────────────────────────────────

export function handlePromote(store: TaskStore, params: TaskActionParams): TaskToolResult {
	if (params.id === undefined) {
		return error(store, "promote", "Task ID is required");
	}

	const task = findTask(store, params.id);
	if (!task) return error(store, "promote", `Task #${params.id} not found`);

	if (task.parentId === null) {
		return error(store, "promote", `Task #${task.id} is already at top level`);
	}

	const oldParentId = task.parentId;
	const parent = findTask(store, task.parentId);
	const grandparentId = parent?.parentId ?? null;

	task.parentId = grandparentId;

	// Re-derive old parent (may have lost last child)
	if (oldParentId !== null) updateAncestorStatuses(store, oldParentId);
	// Re-derive new parent (grandparent)
	if (grandparentId !== null) updateAncestorStatuses(store, grandparentId);

	const dest = grandparentId !== null ? `under #${grandparentId}` : "top level";
	return result(store, "promote", `#${task.id} promoted to ${dest}`);
}

// ─── Flatten ─────────────────────────────────────────────────────

export function handleFlatten(store: TaskStore, params: TaskActionParams): TaskToolResult {
	if (params.id === undefined) {
		return error(store, "flatten", "Task ID is required");
	}

	const task = findTask(store, params.id);
	if (!task) return error(store, "flatten", `Task #${params.id} not found`);

	if (task.parentId === null) {
		return error(store, "flatten", `Task #${task.id} is already at top level`);
	}

	const oldParentId = task.parentId;
	task.parentId = null;

	// Re-derive old parent (may have lost last child)
	if (oldParentId !== null) updateAncestorStatuses(store, oldParentId);

	return result(store, "flatten", `#${task.id} flattened to top level`);
}

// ─── Tree View ───────────────────────────────────────────────────

export function handleTree(store: TaskStore, _params: TaskActionParams): TaskToolResult {
	if (store.tasks.length === 0) {
		return result(store, "tree", "No tasks");
	}

	const lines = renderTreeText(store);
	return result(store, "tree", lines.join("\n"));
}

export function renderTreeText(store: TaskStore): string[] {
	const lines: string[] = [];
	const rootTasks = store.tasks.filter((t) => t.parentId === null);

	for (const root of rootTasks) {
		renderNode(store, root, lines, "", true);
	}

	return lines;
}

function renderNode(store: TaskStore, task: typeof store.tasks[0], lines: string[], prefix: string, isLast: boolean): void {
	const connector = prefix === "" ? "" : isLast ? "└── " : "├── ";
	const statusIcon = task.status === "done" ? "✓" : task.status === "in_progress" ? "●" : task.status === "blocked" ? "⊘" : "○";
	const pri = task.priority[0].toUpperCase();

	const children = store.tasks.filter((t) => t.parentId === task.id);
	const hasChildren = children.length > 0;
	const folderIcon = hasChildren ? "📁 " : "";

	// Group containers show ⟳ prefix on status and (done/total) counter
	let statusText: string;
	if (hasChildren) {
		const doneCount = children.filter((c) => c.status === "done").length;
		statusText = `⟳ ${task.status} (${doneCount}/${children.length})`;
	} else {
		statusText = task.status;
	}

	lines.push(`${prefix}${connector}${folderIcon}${statusIcon} #${task.id} [${pri}] ${task.title}  ${statusText}`);

	const childPrefix = prefix + (prefix === "" ? "" : isLast ? "    " : "│   ");
	for (let i = 0; i < children.length; i++) {
		renderNode(store, children[i], lines, childPrefix === "" ? "   " : childPrefix, i === children.length - 1);
	}
}


