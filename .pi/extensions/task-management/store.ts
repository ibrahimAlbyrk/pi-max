/**
 * Task Store — Pure functions for state operations
 *
 * All functions here are pure: they receive state + params, mutate state,
 * and return a text summary. No side effects, no session access.
 */

import type { Task, TaskStore, TaskPriority, TaskStatus } from "./types.js";

// ─── Factory ─────────────────────────────────────────────────────

export function createDefaultStore(): TaskStore {
	return {
		tasks: [],
		sprints: [],
		nextTaskId: 1,
		nextSprintId: 1,
		activeTaskId: null,
		activeSprintId: null,
	};
}

export function createTask(
	store: TaskStore,
	partial: Partial<Task> & { title: string },
): Task {
	return {
		id: store.nextTaskId,
		title: partial.title,
		description: partial.description ?? "",
		status: partial.status ?? "todo",
		priority: partial.priority ?? "medium",
		tags: partial.tags ?? [],
		parentId: partial.parentId ?? null,
		dependsOn: partial.dependsOn ?? [],
		sprintId: partial.sprintId ?? null,
		notes: [],
		estimatedMinutes: partial.estimatedMinutes ?? null,
		actualMinutes: partial.actualMinutes ?? null,
		startedAt: null,
		completedAt: null,
		createdAt: new Date().toISOString(),
		assignee: partial.assignee ?? null,
		agentId: partial.agentId ?? null,
		agentName: partial.agentName ?? null,
		agentColor: partial.agentColor ?? null,
	};
}

// ─── Lookup ──────────────────────────────────────────────────────

export function findTask(store: TaskStore, id: number): Task | undefined {
	return store.tasks.find((t) => t.id === id);
}

export function getSubtasks(store: TaskStore, parentId: number): Task[] {
	return store.tasks.filter((t) => t.parentId === parentId);
}

export function getAllDescendants(store: TaskStore, parentId: number): Task[] {
	const result: Task[] = [];
	const stack = [parentId];
	while (stack.length > 0) {
		const current = stack.pop()!;
		const children = store.tasks.filter((t) => t.parentId === current);
		for (const child of children) {
			result.push(child);
			stack.push(child.id);
		}
	}
	return result;
}

// ─── Group Container (Parent = implicit group) ──────────────────

/**
 * A task is a group container if it has any children.
 * Group containers have auto-derived status and cannot be manually changed.
 */
export function isGroupContainer(store: TaskStore, taskId: number): boolean {
	return store.tasks.some((t) => t.parentId === taskId);
}

/**
 * Derive parent status from children's statuses.
 * Rules:
 *  - All done → done
 *  - All todo → todo
 *  - All deferred → deferred
 *  - All blocked → blocked
 *  - Any in_progress/in_review → in_progress
 *  - Mixed (e.g. some done + some todo) → in_progress
 *  - No children → todo
 */
export function deriveParentStatus(children: Task[]): TaskStatus {
	if (children.length === 0) return "todo";

	const statuses = children.map((c) => c.status);

	if (statuses.every((s) => s === "done")) return "done";
	if (statuses.every((s) => s === "todo")) return "todo";
	if (statuses.every((s) => s === "deferred")) return "deferred";
	if (statuses.every((s) => s === "blocked")) return "blocked";
	if (statuses.some((s) => s === "in_progress" || s === "in_review")) return "in_progress";

	// Mixed states (e.g. some done + some todo, but nothing active)
	return "in_progress";
}

/**
 * Walk up the parentId chain and re-derive each ancestor's status.
 * Must be called after any subtask status change, create, delete, or move.
 */
export function updateAncestorStatuses(store: TaskStore, parentId: number | null): void {
	let current = parentId;
	while (current !== null) {
		const parent = store.tasks.find((t) => t.id === current);
		if (!parent) break;
		const children = store.tasks.filter((t) => t.parentId === current);
		if (children.length === 0) break; // not a group container
		const newStatus = deriveParentStatus(children);
		if (parent.status === newStatus) break; // no change, stop cascading
		parent.status = newStatus;

		// Auto-set timestamps for derived status
		if (newStatus === "done" && !parent.completedAt) {
			parent.completedAt = new Date().toISOString();
		}
		if (newStatus === "in_progress" && !parent.startedAt) {
			parent.startedAt = new Date().toISOString();
		}

		current = parent.parentId;
	}
}

/**
 * Recompute all parent statuses in the store.
 * Call after loading from storage or reconstructing from session
 * to ensure derived statuses are always in sync.
 */
export function recomputeAllParentStatuses(store: TaskStore): void {
	// Process bottom-up: leaf parents first, then their parents, etc.
	// Simple approach: iterate until no changes (max depth iterations)
	let changed = true;
	while (changed) {
		changed = false;
		for (const task of store.tasks) {
			const children = store.tasks.filter((t) => t.parentId === task.id);
			if (children.length === 0) continue; // leaf task, skip
			const derived = deriveParentStatus(children);
			if (task.status !== derived) {
				task.status = derived;
				if (derived === "done" && !task.completedAt) {
					task.completedAt = new Date().toISOString();
				}
				if (derived === "in_progress" && !task.startedAt) {
					task.startedAt = new Date().toISOString();
				}
				changed = true;
			}
		}
	}
}

// ─── Agent Assignment ────────────────────────────────────────────

export interface AgentAssignment {
	agentId: string;
	agentName: string;
	agentColor: string;
}

/**
 * Assign an agent to a task. Sets assignee to "agent" and stores agent details.
 */
export function assignAgentToTask(store: TaskStore, taskId: number, agent: AgentAssignment): boolean {
	const task = findTask(store, taskId);
	if (!task) return false;
	task.assignee = "agent";
	task.agentId = agent.agentId;
	task.agentName = agent.agentName;
	task.agentColor = agent.agentColor;
	return true;
}

/**
 * Remove agent assignment from a task. Keeps assignee as "agent" for historical record.
 */
export function unassignAgentFromTask(store: TaskStore, taskId: number): boolean {
	const task = findTask(store, taskId);
	if (!task) return false;
	task.agentId = null;
	task.agentName = null;
	task.agentColor = null;
	return true;
}

// ─── Filtering ───────────────────────────────────────────────────

export function filterTasks(
	store: TaskStore,
	filters: {
		status?: TaskStatus;
		priority?: TaskPriority;
		tag?: string;
		parentId?: number;
	},
): Task[] {
	let result = store.tasks;

	if (filters.status) {
		result = result.filter((t) => t.status === filters.status);
	}
	if (filters.priority) {
		result = result.filter((t) => t.priority === filters.priority);
	}
	if (filters.tag) {
		const tagLower = filters.tag.toLowerCase();
		result = result.filter((t) => t.tags.some((tag) => tag.toLowerCase() === tagLower));
	}
	if (filters.parentId !== undefined) {
		result = result.filter((t) => t.parentId === filters.parentId);
	}

	return result;
}

// ─── Status helpers ──────────────────────────────────────────────

export function formatElapsed(ms: number): string {
	const minutes = Math.round(ms / 60000);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	const mins = minutes % 60;
	return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
}

// ─── ID Recalculation ────────────────────────────────────────────

/**
 * Recalculate nextTaskId and nextSprintId based on current active items.
 * Call after any operation that removes tasks/sprints (delete, archive, sprint complete).
 *
 * - If no active tasks → nextTaskId resets to 1
 * - If active tasks exist → nextTaskId = max(task IDs) + 1
 * - Same logic for sprints
 */
export function recalculateNextIds(store: TaskStore): void {
	store.nextTaskId = store.tasks.length > 0
		? Math.max(...store.tasks.map((t) => t.id)) + 1
		: 1;
	store.nextSprintId = store.sprints.length > 0
		? Math.max(...store.sprints.map((s) => s.id)) + 1
		: 1;
}

// ─── Snapshot ────────────────────────────────────────────────────

/**
 * Deep-clone a TaskStore.
 *
 * Uses structuredClone (V8-native, ~2-3x faster than JSON round-trip)
 * with a JSON fallback for environments that don't support it.
 */
export function cloneStore(store: TaskStore): TaskStore {
	if (typeof structuredClone === "function") {
		return structuredClone(store);
	}
	return JSON.parse(JSON.stringify(store));
}

/**
 * Create a lightweight store snapshot containing only metadata + task/sprint
 * summaries (no notes, no descriptions). Used for tool result details where
 * full fidelity isn't needed — the canonical state lives in file storage.
 *
 * This reduces context window usage by ~60-80% for large stores.
 */
export function createLightSnapshot(store: TaskStore): TaskStore {
	return {
		tasks: store.tasks.map((t) => ({
			...t,
			description: t.description.length > 100 ? t.description.slice(0, 100) + "…" : t.description,
			notes: t.notes.length > 0
				? [{ timestamp: t.notes[t.notes.length - 1].timestamp, author: t.notes[t.notes.length - 1].author, text: `(${t.notes.length} notes — latest: ${t.notes[t.notes.length - 1].text.slice(0, 80)})` }]
				: [],
		})),
		sprints: store.sprints.map((s) => ({ ...s })),
		nextTaskId: store.nextTaskId,
		nextSprintId: store.nextSprintId,
		activeTaskId: store.activeTaskId,
		activeSprintId: store.activeSprintId,
	};
}

/**
 * Create a minimal snapshot for bulk operations.
 * Only includes counts + affected task IDs, NOT the full task list.
 * For 50+ task bulk ops this saves ~90% of context window tokens.
 */
export function createBulkSnapshot(store: TaskStore, affectedIds: number[]): TaskStore {
	// Status counts for summary
	const counts: Record<string, number> = {};
	for (const t of store.tasks) {
		counts[t.status] = (counts[t.status] || 0) + 1;
	}

	return {
		tasks: [], // Don't include full task list — text summary is enough
		sprints: store.sprints.map((s) => ({ ...s })),
		nextTaskId: store.nextTaskId,
		nextSprintId: store.nextSprintId,
		activeTaskId: store.activeTaskId,
		activeSprintId: store.activeSprintId,
	};
}
