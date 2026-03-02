/**
 * CRUD Actions — create, get, list, update, delete, bulk_create
 */

import type { TaskStore, TaskActionParams, TaskToolResult } from "../types.js";
import { createTask, findTask, getAllDescendants, filterTasks, formatElapsed, recalculateNextIds, isGroupContainer, updateAncestorStatuses, createLightSnapshot } from "../store.js";
import { STATUS_ICONS, priorityLabel } from "../rendering/icons.js";
import { toolResult as result, toolError as error, bulkResult } from "../utils/response.js";
import { resolveBulkTargets, getMissingIds } from "../utils/bulk-targets.js";
import { parseCompactTasks } from "../utils/compact-parser.js";

// ─── Create ──────────────────────────────────────────────────────

export function handleCreate(store: TaskStore, params: TaskActionParams): TaskToolResult {
	if (!params.title?.trim()) {
		return error(store, "create", "Title is required");
	}

	if (params.parentId !== undefined && !findTask(store, params.parentId)) {
		return error(store, "create", `Parent task #${params.parentId} not found`);
	}

	const task = createTask(store, {
		title: params.title.trim(),
		description: params.description,
		priority: params.priority,
		tags: params.tags,
		parentId: params.parentId ?? null,
		assignee: params.assignee,
		estimatedMinutes: params.estimatedMinutes,
	});

	store.tasks.push(task);
	store.nextTaskId++;

	// Auto-derive ancestor statuses if created under a parent
	if (task.parentId !== null) {
		updateAncestorStatuses(store, task.parentId);
	}

	const parts = [`Created #${task.id}: ${task.title}`];
	parts.push(`Status: ${task.status} | Priority: ${task.priority}`);
	if (task.tags.length > 0) parts.push(`Tags: ${task.tags.join(", ")}`);
	if (task.parentId !== null) parts.push(`Parent: #${task.parentId}`);
	if (task.assignee) parts.push(`Assignee: ${task.assignee}`);
	if (task.estimatedMinutes) parts.push(`Estimate: ${task.estimatedMinutes}m`);

	return result(store, "create", parts.join("\n"));
}

// ─── Get ─────────────────────────────────────────────────────────

export function handleGet(store: TaskStore, params: TaskActionParams): TaskToolResult {
	if (params.id === undefined) {
		return error(store, "get", "Task ID is required");
	}

	const task = findTask(store, params.id);
	if (!task) {
		return error(store, "get", `Task #${params.id} not found`);
	}

	const lines: string[] = [];
	lines.push(`#${task.id} — ${task.title}`);
	lines.push(`Status: ${task.status} | Priority: ${task.priority}`);
	if (task.description) lines.push(`Description: ${task.description}`);
	if (task.tags.length > 0) lines.push(`Tags: ${task.tags.join(", ")}`);
	if (task.assignee) {
		let assigneeStr = task.assignee;
		if (task.agentName) assigneeStr += ` (@${task.agentName})`;
		lines.push(`Assignee: ${assigneeStr}`);
	}
	if (task.parentId !== null) lines.push(`Parent: #${task.parentId}`);
	if (task.dependsOn.length > 0) lines.push(`Depends on: ${task.dependsOn.map((d) => `#${d}`).join(", ")}`);
	if (task.estimatedMinutes !== null) lines.push(`Estimated: ${task.estimatedMinutes}m`);
	if (task.actualMinutes !== null) lines.push(`Actual: ${task.actualMinutes}m`);
	if (task.startedAt) lines.push(`Started: ${task.startedAt}`);
	if (task.completedAt) lines.push(`Completed: ${task.completedAt}`);
	lines.push(`Created: ${task.createdAt}`);

	// Subtasks
	const subtasks = store.tasks.filter((t) => t.parentId === task.id);
	if (subtasks.length > 0) {
		lines.push(`\nSubtasks (${subtasks.length}):`);
		for (const st of subtasks) {
			lines.push(`  ${STATUS_ICONS[st.status]} #${st.id} ${st.title} (${st.status})`);
		}
	}

	// Notes
	if (task.notes.length > 0) {
		lines.push(`\nNotes (${task.notes.length}):`);
		for (const note of task.notes) {
			const time = new Date(note.timestamp).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
			lines.push(`  [${note.author} ${time}] ${note.text}`);
		}
	}

	return result(store, "get", lines.join("\n"));
}

// ─── List ────────────────────────────────────────────────────────

export function handleList(store: TaskStore, params: TaskActionParams): TaskToolResult {
	const filtered = filterTasks(store, {
		status: params.filterStatus,
		priority: params.filterPriority,
		tag: params.filterTag,
		parentId: params.filterParentId,
	});

	if (filtered.length === 0) {
		const hasFilters = params.filterStatus || params.filterPriority || params.filterTag || params.filterParentId !== undefined;
		return result(store, "list", hasFilters ? "No tasks match the given filters" : "No tasks yet");
	}

	// Status counts
	const counts: Record<string, number> = {};
	for (const t of filtered) {
		counts[t.status] = (counts[t.status] || 0) + 1;
	}
	const countStr = Object.entries(counts)
		.map(([s, c]) => `${c} ${s}`)
		.join(", ");

	const lines: string[] = [];
	lines.push(`${filtered.length} task(s) (${countStr}):`);
	lines.push("");

	// Sort: priority order, then by id
	const priorityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
	const sorted = [...filtered].sort((a, b) => {
		const pa = priorityOrder[a.priority] ?? 2;
		const pb = priorityOrder[b.priority] ?? 2;
		if (pa !== pb) return pa - pb;
		return a.id - b.id;
	});

	for (const t of sorted) {
		const icon = STATUS_ICONS[t.status];
		const pri = `[${priorityLabel(t.priority)}]`;
		let line = `  ${icon} #${t.id} ${pri} ${t.title}`;

		// Elapsed time for in_progress tasks
		if (t.status === "in_progress" && t.startedAt) {
			const elapsed = Date.now() - new Date(t.startedAt).getTime();
			line += ` (${formatElapsed(elapsed)})`;
		}

		// Actual time for done tasks
		if (t.status === "done" && t.actualMinutes !== null) {
			line += ` (${t.actualMinutes}m)`;
		}

		line += `  ${t.status}`;
		lines.push(line);
	}

	return result(store, "list", lines.join("\n"));
}

// ─── Update ──────────────────────────────────────────────────────

export function handleUpdate(store: TaskStore, params: TaskActionParams): TaskToolResult {
	if (params.id === undefined) {
		return error(store, "update", "Task ID is required");
	}

	const task = findTask(store, params.id);
	if (!task) {
		return error(store, "update", `Task #${params.id} not found`);
	}

	// Group container guards — block status/sprint/dependency changes
	if (isGroupContainer(store, params.id)) {
		if (params.status !== undefined) {
			return error(store, "update", `Task #${params.id} is a group container. Its status is auto-derived from subtasks and cannot be changed manually.`);
		}
	}

	const changes: string[] = [];

	if (params.title !== undefined) {
		task.title = params.title.trim();
		changes.push(`title → "${task.title}"`);
	}
	if (params.description !== undefined) {
		task.description = params.description;
		changes.push(`description updated`);
	}
	if (params.priority !== undefined) {
		const old = task.priority;
		task.priority = params.priority;
		changes.push(`priority: ${old} → ${task.priority}`);
	}
	if (params.tags !== undefined) {
		task.tags = params.tags;
		changes.push(`tags → [${task.tags.join(", ")}]`);
	}
	if (params.assignee !== undefined) {
		task.assignee = params.assignee;
		changes.push(`assignee → ${task.assignee}`);
	}
	if (params.estimatedMinutes !== undefined) {
		task.estimatedMinutes = params.estimatedMinutes;
		changes.push(`estimate → ${task.estimatedMinutes}m`);
	}
	if (params.parentId !== undefined) {
		if (params.parentId !== null && !findTask(store, params.parentId)) {
			return error(store, "update", `Parent task #${params.parentId} not found`);
		}
		const oldParentId = task.parentId;
		task.parentId = params.parentId;
		changes.push(`parent → ${task.parentId !== null ? `#${task.parentId}` : "none"}`);

		// Re-derive both old and new parent
		if (oldParentId !== null) updateAncestorStatuses(store, oldParentId);
		if (task.parentId !== null) updateAncestorStatuses(store, task.parentId);
	}

	if (changes.length === 0) {
		return error(store, "update", "No fields to update provided");
	}

	return result(store, "update", `Updated #${task.id}: ${changes.join(", ")}`);
}

// ─── Delete ──────────────────────────────────────────────────────

export function handleDelete(store: TaskStore, params: TaskActionParams): TaskToolResult {
	if (params.id === undefined) {
		return error(store, "delete", "Task ID is required");
	}

	const task = findTask(store, params.id);
	if (!task) {
		return error(store, "delete", `Task #${params.id} not found`);
	}

	const parentId = task.parentId; // save before deletion

	// Cascade delete subtasks
	const descendants = getAllDescendants(store, task.id);
	const deleteIds = new Set([task.id, ...descendants.map((d) => d.id)]);

	store.tasks = store.tasks.filter((t) => !deleteIds.has(t.id));

	// Clean up orphan references in surviving tasks
	for (const t of store.tasks) {
		// Remove deleted IDs from dependsOn arrays
		if (t.dependsOn.length > 0) {
			t.dependsOn = t.dependsOn.filter((depId) => !deleteIds.has(depId));
		}
		// Clear parentId if it pointed to a deleted task
		if (t.parentId !== null && deleteIds.has(t.parentId)) {
			t.parentId = null;
		}
	}

	// Clear activeTaskId if deleted
	if (store.activeTaskId !== null && deleteIds.has(store.activeTaskId)) {
		store.activeTaskId = null;
	}

	// Recalculate IDs after deletion (resets to 1 if no tasks remain)
	recalculateNextIds(store);

	// Auto-derive parent status (parent may have lost its last child → demoted to leaf)
	if (parentId !== null) {
		updateAncestorStatuses(store, parentId);
	}

	const cascadeMsg = descendants.length > 0
		? ` (and ${descendants.length} subtask${descendants.length > 1 ? "s" : ""})`
		: "";

	return result(store, "delete", `Deleted #${task.id}: ${task.title}${cascadeMsg}`);
}

// ─── Bulk Create ─────────────────────────────────────────────────
//
// Batch-internal references:
//   parentId supports negative values as batch-internal refs.
//   -1 = first task in this batch, -2 = second, etc.
//   This lets the agent build full parent→child hierarchies in a single call.
//
//   Example: [
//     { title: "Epic" },                        // index 0 → gets real ID 10
//     { title: "Subtask A", parentId: -1 },     // -1 → resolves to ID 10
//     { title: "Subtask B", parentId: -1 },     // -1 → resolves to ID 10
//     { title: "Sub-subtask", parentId: -2 },   // -2 → resolves to ID of "Subtask A"
//   ]

export function handleBulkCreate(store: TaskStore, params: TaskActionParams): TaskToolResult {
	// Support compact text format: parse into tasks array
	if (params.text?.trim() && (!params.tasks || params.tasks.length === 0)) {
		const parsed = parseCompactTasks(params.text);
		if (parsed.length === 0) {
			return error(store, "bulk_create", "No tasks found in compact text. Use indented format:\nTitle [priority] #tag @assignee ~30m\n  Subtask title");
		}
		params = { ...params, tasks: parsed };
	}

	if (!params.tasks || params.tasks.length === 0) {
		return error(store, "bulk_create", "Provide tasks array OR text with compact format");
	}

	const created: { id: number; title: string; parentId: number | null }[] = [];
	// Maps batch index (1-based, referenced as negative) → assigned real task ID
	const batchIdMap = new Map<number, number>();
	const skipped: string[] = [];

	for (let i = 0; i < params.tasks.length; i++) {
		const item = params.tasks[i];
		if (!item.title?.trim()) {
			skipped.push(`[${i}] empty title`);
			continue;
		}

		// Resolve parentId: negative = batch-internal ref, positive = existing task
		let resolvedParentId: number | null = null;
		if (item.parentId !== undefined && item.parentId !== null) {
			if (item.parentId < 0) {
				// Batch-internal reference: -1 → index 0, -2 → index 1, etc.
				const refIndex = Math.abs(item.parentId) - 1;
				const realId = batchIdMap.get(refIndex);
				if (realId === undefined) {
					skipped.push(`[${i}] "${item.title}" — batch ref ${item.parentId} not yet created`);
					continue;
				}
				resolvedParentId = realId;
			} else {
				// Positive = existing task ID
				if (!findTask(store, item.parentId)) {
					skipped.push(`[${i}] "${item.title}" — parent #${item.parentId} not found`);
					continue;
				}
				resolvedParentId = item.parentId;
			}
		}

		const task = createTask(store, {
			title: item.title.trim(),
			description: item.description,
			priority: item.priority,
			tags: item.tags,
			parentId: resolvedParentId,
			assignee: item.assignee,
			estimatedMinutes: item.estimatedMinutes,
		});

		store.tasks.push(task);
		batchIdMap.set(i, task.id);
		created.push({ id: task.id, title: task.title, parentId: resolvedParentId });
		store.nextTaskId++;
	}

	if (created.length === 0) {
		const reason = skipped.length > 0 ? `\nSkipped:\n${skipped.map((s) => `  ⚠ ${s}`).join("\n")}` : "";
		return error(store, "bulk_create", `No valid tasks to create${reason}`);
	}

	// Auto-derive ancestor statuses for all affected parents
	const affectedParents = new Set(created.filter((c) => c.parentId !== null).map((c) => c.parentId!));
	for (const pid of affectedParents) {
		updateAncestorStatuses(store, pid);
	}

	const lines = [`Created ${created.length} task(s):`];
	for (const c of created) {
		const parentInfo = c.parentId !== null ? `  (→ #${c.parentId})` : "";
		lines.push(`  ○ #${c.id} ${c.title}${parentInfo}`);
	}
	if (skipped.length > 0) {
		lines.push("");
		lines.push(`Skipped ${skipped.length}:`);
		for (const s of skipped) {
			lines.push(`  ⚠ ${s}`);
		}
	}

	return bulkResult(store, "bulk_create", lines.join("\n"), created.map((c) => c.id));
}

// ─── Bulk Delete ─────────────────────────────────────────────────
//
// Delete multiple tasks by: ids array, filter params, or all (no ids/no filters).
// Cascades subtasks for each targeted root task.

export function handleBulkDelete(store: TaskStore, params: TaskActionParams): TaskToolResult {
	const { tasks: targets, selectionLabel } = resolveBulkTargets(store, params);

	if (targets.length === 0) {
		return error(store, "bulk_delete", `No tasks found (${selectionLabel})`);
	}

	const deleted: { id: number; title: string; descendants: number }[] = [];
	const allDeleteIds = new Set<number>();
	const affectedParents = new Set<number>();

	for (const task of targets) {
		if (allDeleteIds.has(task.id)) continue; // already queued by a parent

		if (task.parentId !== null) affectedParents.add(task.parentId);

		const descendants = getAllDescendants(store, task.id);
		allDeleteIds.add(task.id);
		for (const d of descendants) allDeleteIds.add(d.id);
		deleted.push({ id: task.id, title: task.title, descendants: descendants.length });
	}

	// Remove all at once
	store.tasks = store.tasks.filter((t) => !allDeleteIds.has(t.id));

	// Clean up orphan references
	for (const t of store.tasks) {
		if (t.dependsOn.length > 0) {
			t.dependsOn = t.dependsOn.filter((depId) => !allDeleteIds.has(depId));
		}
		if (t.parentId !== null && allDeleteIds.has(t.parentId)) {
			t.parentId = null;
		}
	}

	if (store.activeTaskId !== null && allDeleteIds.has(store.activeTaskId)) {
		store.activeTaskId = null;
	}

	recalculateNextIds(store);

	for (const pid of affectedParents) {
		if (!allDeleteIds.has(pid)) updateAncestorStatuses(store, pid);
	}

	const notFound = getMissingIds(store, params);
	const totalDeleted = allDeleteIds.size;
	const lines = [`Deleted ${totalDeleted} task(s) (${selectionLabel}):`];
	for (const d of deleted) {
		const cascade = d.descendants > 0 ? ` (+${d.descendants} subtask${d.descendants > 1 ? "s" : ""})` : "";
		lines.push(`  ✕ #${d.id} ${d.title}${cascade}`);
	}
	if (notFound.length > 0) {
		lines.push(`Not found: ${notFound.map((id) => `#${id}`).join(", ")}`);
	}

	return bulkResult(store, "bulk_delete", lines.join("\n"), deleted.map((d) => d.id));
}

// ─── Bulk Update ─────────────────────────────────────────────────
//
// Update shared fields for multiple tasks by: ids, filters, or all.

export function handleBulkUpdate(store: TaskStore, params: TaskActionParams): TaskToolResult {
	const hasFields = params.priority !== undefined || params.tags !== undefined
		|| params.assignee !== undefined || params.estimatedMinutes !== undefined;
	if (!hasFields) {
		return error(store, "bulk_update", "At least one field to update is required (priority, tags, assignee, estimatedMinutes)");
	}

	const { tasks: targets, selectionLabel } = resolveBulkTargets(store, params);

	if (targets.length === 0) {
		return error(store, "bulk_update", `No tasks found (${selectionLabel})`);
	}

	const updated: { id: number; title: string; changes: string[] }[] = [];

	for (const task of targets) {
		const changes: string[] = [];
		if (params.priority !== undefined) {
			const old = task.priority;
			task.priority = params.priority;
			changes.push(`priority: ${old} → ${task.priority}`);
		}
		if (params.tags !== undefined) {
			task.tags = params.tags;
			changes.push(`tags → [${task.tags.join(", ")}]`);
		}
		if (params.assignee !== undefined) {
			task.assignee = params.assignee;
			changes.push(`assignee → ${task.assignee}`);
		}
		if (params.estimatedMinutes !== undefined) {
			task.estimatedMinutes = params.estimatedMinutes;
			changes.push(`estimate → ${task.estimatedMinutes}m`);
		}

		if (changes.length > 0) {
			updated.push({ id: task.id, title: task.title, changes });
		}
	}

	if (updated.length === 0) {
		return error(store, "bulk_update", `No tasks updated (${selectionLabel})`);
	}

	const notFound = getMissingIds(store, params);
	const lines = [`Updated ${updated.length} task(s) (${selectionLabel}):`];
	for (const u of updated) {
		lines.push(`  ✓ #${u.id} ${u.title} — ${u.changes.join(", ")}`);
	}
	if (notFound.length > 0) {
		lines.push(`Not found: ${notFound.map((id) => `#${id}`).join(", ")}`);
	}

	return bulkResult(store, "bulk_update", lines.join("\n"), updated.map((u) => u.id));
}
