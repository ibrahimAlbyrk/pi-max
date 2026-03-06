/**
 * CRUD Actions — create, get, list, update, delete, bulk_create, bulk_delete, bulk_update
 *
 * Migrated from .pi/extensions/task-management/actions/crud.ts
 */

import { priorityLabel, STATUS_ICONS } from "../rendering/icons.js";
import {
	createGroup,
	createTask,
	filterTasks,
	findGroup,
	findTask,
	formatElapsed,
	recalculateNextIds,
} from "../store.js";
import type { TaskActionParams, TaskStore, TaskToolResult } from "../types.js";
import { getMissingIds, resolveBulkTargets } from "../utils/bulk-targets.js";
import type { CompactTask } from "../utils/compact-parser.js";
import { parseCompactTasks } from "../utils/compact-parser.js";
import { bulkResult, toolError, toolResult } from "../utils/response.js";

// ─── Create ──────────────────────────────────────────────────────

export function handleCreate(store: TaskStore, params: TaskActionParams): TaskToolResult {
	if (!params.title?.trim()) {
		return toolError(store, "create", "Title is required");
	}

	// Validate groupId if provided
	if (params.groupId !== undefined && !findGroup(store, params.groupId)) {
		return toolError(store, "create", `Group #G${params.groupId} not found`);
	}

	const task = createTask(store, {
		title: params.title.trim(),
		description: params.description,
		priority: params.priority,
		tags: params.tags,
		groupId: params.groupId ?? null,
		assignee: params.assignee,
		estimatedMinutes: params.estimatedMinutes,
	});

	store.tasks.push(task);
	store.nextTaskId++;

	const parts = [`Created #${task.id}: ${task.title}`];
	parts.push(`Status: ${task.status} | Priority: ${task.priority}`);
	if (task.tags.length > 0) parts.push(`Tags: ${task.tags.join(", ")}`);
	if (task.groupId !== null) {
		const group = findGroup(store, task.groupId);
		parts.push(`Group: G${task.groupId}${group ? ` (${group.name})` : ""}`);
	}
	if (task.assignee) parts.push(`Assignee: ${task.assignee}`);
	if (task.estimatedMinutes) parts.push(`Estimate: ${task.estimatedMinutes}m`);

	return toolResult(store, "create", parts.join("\n"));
}

// ─── Get ─────────────────────────────────────────────────────────

export function handleGet(store: TaskStore, params: TaskActionParams): TaskToolResult {
	if (params.id === undefined) {
		return toolError(store, "get", "Task ID is required");
	}

	const task = findTask(store, params.id);
	if (!task) {
		return toolError(store, "get", `Task #${params.id} not found`);
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
	if (task.groupId !== null) {
		const group = findGroup(store, task.groupId);
		lines.push(`Group: G${task.groupId}${group ? ` (${group.name})` : ""}`);
	}
	if (task.dependsOn.length > 0) lines.push(`Depends on: ${task.dependsOn.map((d) => `#${d}`).join(", ")}`);
	if (task.estimatedMinutes !== null) lines.push(`Estimated: ${task.estimatedMinutes}m`);
	if (task.actualMinutes !== null) lines.push(`Actual: ${task.actualMinutes}m`);
	if (task.startedAt) lines.push(`Started: ${task.startedAt}`);
	if (task.completedAt) lines.push(`Completed: ${task.completedAt}`);
	lines.push(`Created: ${task.createdAt}`);

	if (task.notes.length > 0) {
		lines.push(`\nNotes (${task.notes.length}):`);
		for (const note of task.notes) {
			const time = new Date(note.timestamp).toLocaleTimeString("en-US", {
				hour: "2-digit",
				minute: "2-digit",
			});
			lines.push(`  [${note.author} ${time}] ${note.text}`);
		}
	}

	return toolResult(store, "get", lines.join("\n"));
}

// ─── List ────────────────────────────────────────────────────────

export function handleList(store: TaskStore, params: TaskActionParams): TaskToolResult {
	const filtered = filterTasks(store, {
		status: params.filterStatus,
		priority: params.filterPriority,
		tag: params.filterTag,
		groupId: params.filterGroupId,
	});

	if (filtered.length === 0) {
		const hasFilters =
			params.filterStatus !== undefined ||
			params.filterPriority !== undefined ||
			params.filterTag !== undefined ||
			params.filterGroupId !== undefined;
		return toolResult(store, "list", hasFilters ? "No tasks match the given filters" : "No tasks yet");
	}

	// Status counts
	const counts: Record<string, number> = {};
	for (const t of filtered) {
		counts[t.status] = (counts[t.status] ?? 0) + 1;
	}
	const countStr = Object.entries(counts)
		.map(([s, c]) => `${c} ${s}`)
		.join(", ");

	const lines: string[] = [];
	lines.push(`${filtered.length} task(s) (${countStr}):`);
	lines.push("");

	// Sort: priority order, then by id
	const priorityOrder: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
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

		if (t.status === "in_progress" && t.startedAt) {
			const elapsed = Date.now() - new Date(t.startedAt).getTime();
			line += ` (${formatElapsed(elapsed)})`;
		}

		if (t.status === "done" && t.actualMinutes !== null) {
			line += ` (${t.actualMinutes}m)`;
		}

		line += `  ${t.status}`;
		lines.push(line);
	}

	return toolResult(store, "list", lines.join("\n"));
}

// ─── Update ──────────────────────────────────────────────────────

export function handleUpdate(store: TaskStore, params: TaskActionParams): TaskToolResult {
	if (params.id === undefined) {
		return toolError(store, "update", "Task ID is required");
	}

	const task = findTask(store, params.id);
	if (!task) {
		return toolError(store, "update", `Task #${params.id} not found`);
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
	if (params.groupId !== undefined) {
		// groupId === 0 is the sentinel for "clear group" (set to null)
		if (params.groupId !== 0 && !findGroup(store, params.groupId)) {
			return toolError(store, "update", `Group #G${params.groupId} not found`);
		}
		task.groupId = params.groupId === 0 ? null : params.groupId;
		const group = task.groupId !== null ? findGroup(store, task.groupId) : null;
		changes.push(`group → ${task.groupId !== null ? `G${task.groupId} (${group?.name ?? "?"})` : "none"}`);
	}

	if (changes.length === 0) {
		return toolError(store, "update", "No fields to update provided");
	}

	return toolResult(store, "update", `Updated #${task.id}: ${changes.join(", ")}`);
}

// ─── Delete ──────────────────────────────────────────────────────

export function handleDelete(store: TaskStore, params: TaskActionParams): TaskToolResult {
	if (params.id === undefined) {
		return toolError(store, "delete", "Task ID is required");
	}

	const task = findTask(store, params.id);
	if (!task) {
		return toolError(store, "delete", `Task #${params.id} not found`);
	}

	store.tasks = store.tasks.filter((t) => t.id !== task.id);

	// Clean up dependency references in surviving tasks
	for (const t of store.tasks) {
		if (t.dependsOn.length > 0) {
			t.dependsOn = t.dependsOn.filter((depId) => depId !== task.id);
		}
	}

	if (store.activeTaskId === task.id) {
		store.activeTaskId = null;
	}

	recalculateNextIds(store);

	return toolResult(store, "delete", `Deleted #${task.id}: ${task.title}`);
}

// ─── Bulk Create ─────────────────────────────────────────────────
//
// Supports compact text format where indentation defines groups:
//   - Top-level items with indented children → group + tasks
//   - Top-level items without children → standalone tasks
//   - Deeper nesting is flattened into the nearest group
//
// Also supports JSON tasks array with parentId for backward compat.
// Negative parentId values create groups: the referenced "parent" becomes a group.

export function handleBulkCreate(store: TaskStore, params: TaskActionParams): TaskToolResult {
	// Resolve tasks from compact text format or the tasks array
	let taskItems: CompactTask[] = params.tasks ? [...params.tasks] : [];

	if (params.text?.trim() && taskItems.length === 0) {
		const parsed = parseCompactTasks(params.text);
		if (parsed.length === 0) {
			return toolError(
				store,
				"bulk_create",
				"No tasks found in compact text. Use indented format:\nGroup Name [priority] #tag\n  Task A [priority] @assignee ~30m\n  Task B",
			);
		}
		taskItems = parsed;
	}

	if (taskItems.length === 0) {
		return toolError(store, "bulk_create", "Provide tasks array OR text with compact format");
	}

	// Detect hierarchy and convert parent items to groups.
	// parentId < 0 = batch-internal ref, parentId > 0 = existing group ref.
	const createdTasks: { id: number; title: string; groupId: number | null }[] = [];
	const createdGroups: { id: number; name: string }[] = [];
	// Maps batch index (0-based) → real task/group ID
	const batchIdMap = new Map<number, number>();
	const batchIsGroup = new Set<number>(); // indices that became groups
	const skipped: string[] = [];

	// First pass: identify which batch items will become groups.
	// An item becomes a group if any other item references it as parent.
	for (const item of taskItems) {
		if (item.parentId !== undefined && item.parentId < 0) {
			const refIndex = Math.abs(item.parentId) - 1;
			batchIsGroup.add(refIndex);
		}
	}

	// Second pass: create groups and tasks in order
	for (let i = 0; i < taskItems.length; i++) {
		const item = taskItems[i];
		if (!item.title?.trim()) {
			skipped.push(`[${i}] empty title`);
			continue;
		}

		if (batchIsGroup.has(i)) {
			// This item becomes a group
			const group = createGroup(store, item.title.trim(), item.description ?? "");
			store.groups.push(group);
			batchIdMap.set(i, group.id);
			store.nextGroupId++;
			createdGroups.push({ id: group.id, name: group.name });
			continue;
		}

		// Resolve groupId from parentId reference
		let resolvedGroupId: number | null = null;
		if (item.parentId !== undefined) {
			if (item.parentId < 0) {
				// Batch-internal reference (negative 1-based index)
				const refIndex = Math.abs(item.parentId) - 1;
				const realId = batchIdMap.get(refIndex);
				if (realId === undefined) {
					skipped.push(`[${i}] "${item.title}" — batch ref ${item.parentId} not yet created`);
					continue;
				}
				if (batchIsGroup.has(refIndex)) {
					resolvedGroupId = realId;
				} else {
					// Referenced item is a task — inherit its groupId
					const refTask = store.tasks.find((t) => t.id === realId);
					resolvedGroupId = refTask?.groupId ?? null;
				}
			} else {
				// Positive = reference to an existing group ID
				if (findGroup(store, item.parentId)) {
					resolvedGroupId = item.parentId;
				} else {
					skipped.push(`[${i}] "${item.title}" — group #G${item.parentId} not found`);
					continue;
				}
			}
		}

		const task = createTask(store, {
			title: item.title.trim(),
			description: item.description,
			priority: item.priority,
			tags: item.tags,
			groupId: resolvedGroupId,
			assignee: item.assignee,
			estimatedMinutes: item.estimatedMinutes,
		});

		store.tasks.push(task);
		batchIdMap.set(i, task.id);
		createdTasks.push({ id: task.id, title: task.title, groupId: resolvedGroupId });
		store.nextTaskId++;
	}

	if (createdTasks.length === 0 && createdGroups.length === 0) {
		const reason = skipped.length > 0 ? `\nSkipped:\n${skipped.map((s) => `  ⚠ ${s}`).join("\n")}` : "";
		return toolError(store, "bulk_create", `No valid tasks to create${reason}`);
	}

	const lines: string[] = [];
	if (createdGroups.length > 0) {
		lines.push(`Created ${createdGroups.length} group(s):`);
		for (const g of createdGroups) {
			lines.push(`  ◆ G${g.id} ${g.name}`);
		}
	}
	if (createdTasks.length > 0) {
		lines.push(`Created ${createdTasks.length} task(s):`);
		for (const c of createdTasks) {
			const groupInfo = c.groupId !== null ? `  (→ G${c.groupId})` : "";
			lines.push(`  ○ #${c.id} ${c.title}${groupInfo}`);
		}
	}
	if (skipped.length > 0) {
		lines.push("");
		lines.push(`Skipped ${skipped.length}:`);
		for (const s of skipped) {
			lines.push(`  ⚠ ${s}`);
		}
	}

	return bulkResult(
		store,
		"bulk_create",
		lines.join("\n"),
		createdTasks.map((c) => c.id),
	);
}

// ─── Bulk Delete ─────────────────────────────────────────────────

export function handleBulkDelete(store: TaskStore, params: TaskActionParams): TaskToolResult {
	const { tasks: targets, selectionLabel } = resolveBulkTargets(store, params);

	if (targets.length === 0) {
		return toolError(store, "bulk_delete", `No tasks found (${selectionLabel})`);
	}

	const deleted: { id: number; title: string }[] = [];
	const allDeleteIds = new Set<number>();

	for (const task of targets) {
		allDeleteIds.add(task.id);
		deleted.push({ id: task.id, title: task.title });
	}

	store.tasks = store.tasks.filter((t) => !allDeleteIds.has(t.id));

	// Clean up dependency references
	for (const t of store.tasks) {
		if (t.dependsOn.length > 0) {
			t.dependsOn = t.dependsOn.filter((depId) => !allDeleteIds.has(depId));
		}
	}

	if (store.activeTaskId !== null && allDeleteIds.has(store.activeTaskId)) {
		store.activeTaskId = null;
	}

	recalculateNextIds(store);

	const notFound = getMissingIds(store, params);
	const lines = [`Deleted ${deleted.length} task(s) (${selectionLabel}):`];
	for (const d of deleted) {
		lines.push(`  ✕ #${d.id} ${d.title}`);
	}
	if (notFound.length > 0) {
		lines.push(`Not found: ${notFound.map((id) => `#${id}`).join(", ")}`);
	}

	return bulkResult(
		store,
		"bulk_delete",
		lines.join("\n"),
		deleted.map((d) => d.id),
	);
}

// ─── Bulk Update ─────────────────────────────────────────────────

export function handleBulkUpdate(store: TaskStore, params: TaskActionParams): TaskToolResult {
	const hasFields =
		params.priority !== undefined ||
		params.tags !== undefined ||
		params.assignee !== undefined ||
		params.estimatedMinutes !== undefined;

	if (!hasFields) {
		return toolError(
			store,
			"bulk_update",
			"At least one field to update is required (priority, tags, assignee, estimatedMinutes)",
		);
	}

	const { tasks: targets, selectionLabel } = resolveBulkTargets(store, params);

	if (targets.length === 0) {
		return toolError(store, "bulk_update", `No tasks found (${selectionLabel})`);
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
		return toolError(store, "bulk_update", `No tasks updated (${selectionLabel})`);
	}

	const notFound = getMissingIds(store, params);
	const lines = [`Updated ${updated.length} task(s) (${selectionLabel}):`];
	for (const u of updated) {
		lines.push(`  ✓ #${u.id} ${u.title} — ${u.changes.join(", ")}`);
	}
	if (notFound.length > 0) {
		lines.push(`Not found: ${notFound.map((id) => `#${id}`).join(", ")}`);
	}

	return bulkResult(
		store,
		"bulk_update",
		lines.join("\n"),
		updated.map((u) => u.id),
	);
}
