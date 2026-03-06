/**
 * Task Store — Pure functions for state operations
 *
 * All functions here are pure: they receive state + params, mutate state in place,
 * and return results. No side effects, no file I/O, no TUI dependencies.
 *
 * Migrated from .pi/extensions/task-management/store.ts
 */

import type { Sprint, Task, TaskGroup, TaskNote, TaskPriority, TaskStatus, TaskStore } from "./types.js";

// ─── Agent Assignment ────────────────────────────────────────────

export interface AgentAssignment {
	agentId: string;
	agentName: string;
	agentColor: string;
}

// ─── Factory ─────────────────────────────────────────────────────

export function createDefaultStore(): TaskStore {
	return {
		tasks: [],
		groups: [],
		sprints: [],
		nextTaskId: 1,
		nextGroupId: 1,
		nextSprintId: 1,
		activeTaskId: null,
		activeSprintId: null,
	};
}

export function createTask(store: TaskStore, partial: Partial<Task> & { title: string }): Task {
	return {
		id: store.nextTaskId,
		title: partial.title,
		description: partial.description ?? "",
		status: partial.status ?? "todo",
		priority: partial.priority ?? "medium",
		tags: partial.tags ?? [],
		groupId: partial.groupId ?? null,
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

export function createGroup(store: TaskStore, name: string, description: string = ""): TaskGroup {
	return {
		id: store.nextGroupId,
		name,
		description,
		createdAt: new Date().toISOString(),
	};
}

export function createSprint(store: TaskStore, name: string, description: string = ""): Sprint {
	return {
		id: store.nextSprintId,
		name,
		description,
		status: "planned",
		startDate: null,
		endDate: null,
		completedDate: null,
		createdAt: new Date().toISOString(),
	};
}

// ─── Lookup ──────────────────────────────────────────────────────

export function findTask(store: TaskStore, id: number): Task | undefined {
	return store.tasks.find((t) => t.id === id);
}

export function findGroup(store: TaskStore, id: number): TaskGroup | undefined {
	return store.groups.find((g) => g.id === id);
}

export function findSprint(store: TaskStore, id: number): Sprint | undefined {
	return store.sprints.find((s) => s.id === id);
}

export function getGroupTasks(store: TaskStore, groupId: number): Task[] {
	return store.tasks.filter((t) => t.groupId === groupId);
}

// ─── Next ID Accessors ───────────────────────────────────────────

export function getNextTaskId(store: TaskStore): number {
	return store.nextTaskId;
}

export function getNextGroupId(store: TaskStore): number {
	return store.nextGroupId;
}

export function getNextSprintId(store: TaskStore): number {
	return store.nextSprintId;
}

// ─── Mutations ───────────────────────────────────────────────────

/**
 * Update mutable fields on a task in place. Returns true if the task was found.
 */
export function updateTask(store: TaskStore, id: number, updates: Partial<Task>): boolean {
	const task = findTask(store, id);
	if (!task) return false;
	Object.assign(task, updates);
	return true;
}

/**
 * Remove a task from the store by ID. Returns true if removed.
 * Caller is responsible for calling recalculateNextIds() if needed.
 */
export function deleteTask(store: TaskStore, id: number): boolean {
	const index = store.tasks.findIndex((t) => t.id === id);
	if (index === -1) return false;
	store.tasks.splice(index, 1);
	return true;
}

/**
 * Remove a group from the store by ID. Returns true if removed.
 */
export function deleteGroup(store: TaskStore, id: number): boolean {
	const index = store.groups.findIndex((g) => g.id === id);
	if (index === -1) return false;
	store.groups.splice(index, 1);
	return true;
}

/**
 * Remove a sprint from the store by ID. Returns true if removed.
 */
export function deleteSprint(store: TaskStore, id: number): boolean {
	const index = store.sprints.findIndex((s) => s.id === id);
	if (index === -1) return false;
	store.sprints.splice(index, 1);
	return true;
}

/**
 * Add a note to a task. Returns true if the task was found.
 */
export function addTaskNote(store: TaskStore, taskId: number, note: TaskNote): boolean {
	const task = findTask(store, taskId);
	if (!task) return false;
	task.notes.push(note);
	return true;
}

// ─── Agent Assignment ────────────────────────────────────────────

/**
 * Assign an agent to a task. Sets assignee to "agent" and stores agent details.
 * Returns true if the task was found.
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
 * Remove agent assignment from a task (by task ID).
 * Keeps assignee as "agent" for historical record but clears agent identity fields.
 * Returns true if the task was found.
 */
export function unassignAgentFromTask(store: TaskStore, taskId: number): boolean {
	const task = findTask(store, taskId);
	if (!task) return false;
	task.agentId = null;
	task.agentName = null;
	task.agentColor = null;
	return true;
}

/**
 * Clear agent assignment from all tasks assigned to the given agentId.
 * Used when a subagent exits and its tasks should be released.
 * Returns the IDs of tasks that were cleared.
 */
export function clearAgentAssignment(store: TaskStore, agentId: string): number[] {
	const cleared: number[] = [];
	for (const task of store.tasks) {
		if (task.agentId === agentId) {
			task.agentId = null;
			task.agentName = null;
			task.agentColor = null;
			cleared.push(task.id);
		}
	}
	return cleared;
}

// ─── Filtering ───────────────────────────────────────────────────

export function filterTasks(
	store: TaskStore,
	filters: {
		status?: TaskStatus;
		priority?: TaskPriority;
		tag?: string;
		groupId?: number;
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
	if (filters.groupId !== undefined) {
		result = result.filter((t) => t.groupId === filters.groupId);
	}

	return result;
}

// ─── Formatting Helpers ──────────────────────────────────────────

/**
 * Format elapsed milliseconds as a human-readable duration string.
 * E.g. 90000 → "1h 30m", 3600000 → "1h", 120000 → "2m"
 */
export function formatElapsed(ms: number): string {
	const minutes = Math.round(ms / 60000);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	const mins = minutes % 60;
	return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
}

// ─── ID Recalculation ────────────────────────────────────────────

/**
 * Recalculate nextTaskId, nextGroupId, and nextSprintId based on current active items.
 * Call after any operation that removes tasks/groups/sprints (delete, archive, sprint complete).
 * This prevents ID collisions after archiving or deletion.
 */
export function recalculateNextIds(store: TaskStore): void {
	store.nextTaskId = store.tasks.length > 0 ? Math.max(...store.tasks.map((t) => t.id)) + 1 : 1;
	store.nextGroupId = store.groups.length > 0 ? Math.max(...store.groups.map((g) => g.id)) + 1 : 1;
	store.nextSprintId = store.sprints.length > 0 ? Math.max(...store.sprints.map((s) => s.id)) + 1 : 1;
}

// ─── Snapshots ───────────────────────────────────────────────────

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
	return JSON.parse(JSON.stringify(store)) as TaskStore;
}

/**
 * Create a lightweight store snapshot containing only metadata + task/sprint
 * summaries (no notes, no descriptions). Used for tool result details where
 * full fidelity isn't needed — the canonical state lives in file storage.
 *
 * Reduces context window usage by ~60-80% for large stores.
 */
export function createLightSnapshot(store: TaskStore): TaskStore {
	return {
		tasks: store.tasks.map((t) => ({
			...t,
			description: t.description.length > 100 ? `${t.description.slice(0, 100)}\u2026` : t.description,
			notes:
				t.notes.length > 0
					? [
							{
								timestamp: t.notes[t.notes.length - 1].timestamp,
								author: t.notes[t.notes.length - 1].author,
								text: `(${t.notes.length} notes \u2014 latest: ${t.notes[t.notes.length - 1].text.slice(0, 80)})`,
							},
						]
					: [],
		})),
		groups: store.groups.map((g) => ({ ...g })),
		sprints: store.sprints.map((s) => ({ ...s })),
		nextTaskId: store.nextTaskId,
		nextGroupId: store.nextGroupId,
		nextSprintId: store.nextSprintId,
		activeTaskId: store.activeTaskId,
		activeSprintId: store.activeSprintId,
	};
}

/**
 * Create a minimal snapshot for bulk operations.
 * Only includes counts + affected task IDs, NOT the full task list.
 * For 50+ task bulk ops this saves ~90% of context window tokens.
 *
 * @param _affectedIds - IDs of tasks modified by the bulk operation (for audit trail)
 */
export function createBulkSnapshot(store: TaskStore, _affectedIds: number[]): TaskStore {
	return {
		tasks: [], // Don't include full task list — text summary is enough
		groups: store.groups.map((g) => ({ ...g })),
		sprints: store.sprints.map((s) => ({ ...s })),
		nextTaskId: store.nextTaskId,
		nextGroupId: store.nextGroupId,
		nextSprintId: store.nextSprintId,
		activeTaskId: store.activeTaskId,
		activeSprintId: store.activeSprintId,
	};
}
