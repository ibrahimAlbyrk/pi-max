/**
 * Shared bulk target resolution.
 *
 * All bulk operations (bulk_delete, bulk_set_status, bulk_update, bulk_assign_sprint)
 * can target tasks in 3 ways:
 *   1. Explicit ids array  → only those tasks
 *   2. Filter params       → tasks matching filterStatus/filterPriority/filterTag/filterGroupId
 *   3. Neither             → ALL tasks
 *
 * This helper resolves params into a concrete Task[] list.
 *
 * WARNING: No filters + no ids = ALL tasks. This is intentional but must be
 * handled carefully by callers (see spec section 17.5).
 */

import type { Task, TaskActionParams, TaskStore } from "../types.js";

export interface BulkTargetResult {
	tasks: Task[];
	/** Human-readable description of how targets were selected */
	selectionLabel: string;
}

/**
 * Resolve bulk operation targets from params.
 * Priority: ids > filters > all.
 */
export function resolveBulkTargets(store: TaskStore, params: TaskActionParams): BulkTargetResult {
	// 1. Explicit ids
	if (params.ids && params.ids.length > 0) {
		const tasks: Task[] = [];
		for (const id of params.ids) {
			const t = store.tasks.find((t) => t.id === id);
			if (t) tasks.push(t);
		}
		return {
			tasks,
			selectionLabel: `ids [${params.ids.join(", ")}]`,
		};
	}

	// 2. Filters
	const hasFilters =
		params.filterStatus !== undefined ||
		params.filterPriority !== undefined ||
		params.filterTag !== undefined ||
		params.filterGroupId !== undefined;

	if (hasFilters) {
		let result = store.tasks;
		const filterParts: string[] = [];

		if (params.filterStatus) {
			result = result.filter((t) => t.status === params.filterStatus);
			filterParts.push(`status=${params.filterStatus}`);
		}
		if (params.filterPriority) {
			result = result.filter((t) => t.priority === params.filterPriority);
			filterParts.push(`priority=${params.filterPriority}`);
		}
		if (params.filterTag) {
			const tagLower = params.filterTag.toLowerCase();
			result = result.filter((t) => t.tags.some((tag) => tag.toLowerCase() === tagLower));
			filterParts.push(`tag=${params.filterTag}`);
		}
		if (params.filterGroupId !== undefined) {
			result = result.filter((t) => t.groupId === params.filterGroupId);
			filterParts.push(`group=G${params.filterGroupId}`);
		}

		return {
			tasks: result,
			selectionLabel: `filter(${filterParts.join(", ")})`,
		};
	}

	// 3. No ids, no filters → ALL tasks
	return {
		tasks: [...store.tasks],
		selectionLabel: "all tasks",
	};
}

/**
 * Get IDs that were requested but not found in store.
 * Only relevant when explicit ids were provided.
 */
export function getMissingIds(store: TaskStore, params: TaskActionParams): number[] {
	if (!params.ids || params.ids.length === 0) return [];
	const existingIds = new Set(store.tasks.map((t) => t.id));
	return params.ids.filter((id) => !existingIds.has(id));
}
