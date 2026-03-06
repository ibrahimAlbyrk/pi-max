/**
 * Merge — Conflict resolution when importing tasks into existing store
 *
 * Two modes:
 *   - "merge"   → match by title, update status/priority, create unmatched
 *   - "replace" → clear existing tasks, import fresh
 *
 * The merge plan is computed first, then applied, so it can be shown to the user.
 */

import type { Task, TaskStore } from "../types.js";
import type { ParsedTask } from "./parser.js";
import { createTask } from "../store.js";

export interface MergePlan {
	updates: { existingId: number; existingTitle: string; changes: Partial<Task> }[];
	creates: ParsedTask[];
	unchanged: number;
}

/**
 * Compute a merge plan: match incoming tasks against existing by title.
 */
export function planMerge(existing: Task[], incoming: ParsedTask[]): MergePlan {
	const updates: MergePlan["updates"] = [];
	const creates: ParsedTask[] = [];
	let unchanged = 0;

	for (const inc of incoming) {
		const match = existing.find(
			(e) => e.title.toLowerCase().trim() === inc.title.toLowerCase().trim(),
		);

		if (match) {
			const changes: Partial<Task> = {};
			if (inc.status !== match.status) changes.status = inc.status;
			if (inc.priority && inc.priority !== match.priority) changes.priority = inc.priority;
			if (inc.description && inc.description !== match.description) changes.description = inc.description;
			if (inc.assignee && inc.assignee !== match.assignee) changes.assignee = inc.assignee;
			if (inc.tags && inc.tags.length > 0) {
				const newTags = inc.tags.filter((t) => !match.tags.includes(t));
				if (newTags.length > 0) changes.tags = [...match.tags, ...newTags];
			}

			if (Object.keys(changes).length > 0) {
				updates.push({ existingId: match.id, existingTitle: match.title, changes });
			} else {
				unchanged++;
			}
		} else {
			creates.push(inc);
		}
	}

	return { updates, creates, unchanged };
}

/**
 * Apply a merge plan to the store.
 */
export function applyMerge(store: TaskStore, plan: MergePlan): { created: number; updated: number } {
	// Apply updates
	for (const update of plan.updates) {
		const task = store.tasks.find((t) => t.id === update.existingId);
		if (task) {
			Object.assign(task, update.changes);

			// Handle status transitions
			if (update.changes.status === "in_progress" && !task.startedAt) {
				task.startedAt = new Date().toISOString();
			}
			if (update.changes.status === "done" && !task.completedAt) {
				task.completedAt = new Date().toISOString();
			}
		}
	}

	// Create new tasks
	const titleToId = new Map<string, number>();
	for (const t of store.tasks) {
		titleToId.set(t.title.toLowerCase().trim(), t.id);
	}

	for (const parsed of plan.creates) {
		const task = createTask(store, {
			title: parsed.title,
			description: parsed.description,
			status: parsed.status,
			priority: parsed.priority,
			tags: parsed.tags,
			assignee: parsed.assignee,
			estimatedMinutes: parsed.estimatedMinutes,
		});

		// Resolve parent by title → find or create a group
		if (parsed.parentTitle) {
			const parentTitle = parsed.parentTitle.toLowerCase().trim();
			// Check if a group with this name already exists
			let group = store.groups.find((g) => g.name.toLowerCase().trim() === parentTitle);
			if (!group) {
				// Check if a task with this title exists and could be a group
				const parentTaskId = titleToId.get(parentTitle);
				if (parentTaskId != null) {
					// Convert existing task to group reference
					const parentTask = store.tasks.find((t) => t.id === parentTaskId);
					if (parentTask) {
						group = {
							id: store.nextGroupId,
							name: parentTask.title,
							description: parentTask.description || "",
							createdAt: parentTask.createdAt,
						};
						store.groups.push(group);
						store.nextGroupId++;
					}
				}
			}
			if (group) task.groupId = group.id;
		}

		store.tasks.push(task);
		titleToId.set(task.title.toLowerCase().trim(), task.id);
		store.nextTaskId++;

		// Import notes
		if (parsed.notes) {
			for (const noteText of parsed.notes) {
				task.notes.push({
					timestamp: new Date().toISOString(),
					author: "user",
					text: noteText,
				});
			}
		}
	}

	// Resolve dependsOnTitles → dependsOn IDs (second pass)
	for (const parsed of plan.creates) {
		if (!parsed.dependsOnTitles || parsed.dependsOnTitles.length === 0) continue;
		const task = store.tasks.find((t) => t.title === parsed.title);
		if (!task) continue;

		for (const depTitle of parsed.dependsOnTitles) {
			const depId = titleToId.get(depTitle.toLowerCase().trim());
			if (depId != null && !task.dependsOn.includes(depId)) {
				task.dependsOn.push(depId);
			}
		}
	}

	return { created: plan.creates.length, updated: plan.updates.length };
}

/**
 * Format a merge plan as a human-readable summary.
 */
export function formatMergePlan(plan: MergePlan): string {
	const lines: string[] = [];

	if (plan.creates.length > 0) {
		lines.push(`New tasks (${plan.creates.length}):`);
		for (const t of plan.creates.slice(0, 10)) {
			lines.push(`  + ${t.title} [${t.priority ?? "medium"}] (${t.status})`);
		}
		if (plan.creates.length > 10) lines.push(`  ... and ${plan.creates.length - 10} more`);
	}

	if (plan.updates.length > 0) {
		lines.push(`Updates (${plan.updates.length}):`);
		for (const u of plan.updates.slice(0, 10)) {
			const changes = Object.entries(u.changes).map(([k, v]) => `${k}→${v}`).join(", ");
			lines.push(`  ~ #${u.existingId} ${u.existingTitle}: ${changes}`);
		}
		if (plan.updates.length > 10) lines.push(`  ... and ${plan.updates.length - 10} more`);
	}

	if (plan.unchanged > 0) {
		lines.push(`Unchanged: ${plan.unchanged}`);
	}

	return lines.join("\n");
}
