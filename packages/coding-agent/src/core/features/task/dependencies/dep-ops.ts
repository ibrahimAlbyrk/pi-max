/**
 * Dependency Operations — add_dependency, remove_dependency, check_dependencies, cycle detection
 *
 * Dependencies are stored in task.dependsOn array.
 * Cycle detection uses iterative DFS to prevent A→B→C→A loops.
 */

import { findTask } from "../store.js";
import type { TaskActionParams, TaskStore, TaskToolResult } from "../types.js";
import { toolError as error, toolResult as result } from "../utils/response.js";

// ─── Cycle Detection ─────────────────────────────────────────────

/**
 * Detect whether adding a dependency from `taskId` → `newDep` would create a cycle.
 *
 * Strategy: starting from `newDep`, walk the dependency graph via DFS. If we ever
 * reach `taskId` again, the new edge would form a cycle.
 *
 * @param store  - current task store
 * @param taskId - the task that would gain the new dependency
 * @param newDep - the task that `taskId` would depend on
 * @returns true if adding this dependency would create a cycle
 */
export function hasCycle(store: TaskStore, taskId: number, newDep: number): boolean {
	const visited = new Set<number>();
	const stack = [newDep];

	while (stack.length > 0) {
		const current = stack.pop()!;
		if (current === taskId) return true;
		if (visited.has(current)) continue;
		visited.add(current);

		const task = store.tasks.find((t) => t.id === current);
		if (task) {
			stack.push(...task.dependsOn);
		}
	}
	return false;
}

// ─── Add Dependency ──────────────────────────────────────────────

export function handleAddDependency(store: TaskStore, params: TaskActionParams): TaskToolResult {
	if (params.id === undefined) {
		return error(store, "add_dependency", "Task ID is required");
	}
	if (params.parentId === undefined) {
		// parentId is reused as "depends on target" to avoid adding a new param
		return error(
			store,
			"add_dependency",
			"Target task ID (parentId field) is required — the task that this task depends on",
		);
	}

	const task = findTask(store, params.id);
	if (!task) return error(store, "add_dependency", `Task #${params.id} not found`);

	const target = findTask(store, params.parentId);
	if (!target) return error(store, "add_dependency", `Target task #${params.parentId} not found`);

	if (params.id === params.parentId) {
		return error(store, "add_dependency", "A task cannot depend on itself");
	}

	if (task.dependsOn.includes(params.parentId)) {
		return error(store, "add_dependency", `#${params.id} already depends on #${params.parentId}`);
	}

	if (hasCycle(store, params.id, params.parentId)) {
		return error(
			store,
			"add_dependency",
			`Circular dependency: #${params.parentId} already depends on #${params.id} (directly or indirectly)`,
		);
	}

	task.dependsOn.push(params.parentId);

	let text = `#${task.id} now depends on #${target.id} (${target.title})`;
	if (target.status === "done") {
		text += "\nNote: Dependency is already completed.";
	}

	return result(store, "add_dependency", text);
}

// ─── Remove Dependency ───────────────────────────────────────────

export function handleRemoveDependency(store: TaskStore, params: TaskActionParams): TaskToolResult {
	if (params.id === undefined) {
		return error(store, "remove_dependency", "Task ID is required");
	}
	if (params.parentId === undefined) {
		return error(store, "remove_dependency", "Target task ID (parentId field) is required");
	}

	const task = findTask(store, params.id);
	if (!task) return error(store, "remove_dependency", `Task #${params.id} not found`);

	const idx = task.dependsOn.indexOf(params.parentId);
	if (idx === -1) {
		return error(store, "remove_dependency", `#${params.id} does not depend on #${params.parentId}`);
	}

	task.dependsOn.splice(idx, 1);
	return result(
		store,
		"remove_dependency",
		`Removed dependency: #${params.id} no longer depends on #${params.parentId}`,
	);
}

// ─── Check Dependencies ──────────────────────────────────────────

export function handleCheckDependencies(store: TaskStore, params: TaskActionParams): TaskToolResult {
	if (params.id === undefined) {
		return error(store, "check_dependencies", "Task ID is required");
	}

	const task = findTask(store, params.id);
	if (!task) return error(store, "check_dependencies", `Task #${params.id} not found`);

	if (task.dependsOn.length === 0) {
		return result(store, "check_dependencies", `#${task.id} has no dependencies — ready to start`);
	}

	const lines: string[] = [`Dependencies for #${task.id} (${task.title}):`];
	let allMet = true;

	for (const depId of task.dependsOn) {
		const dep = findTask(store, depId);
		if (!dep) {
			lines.push(`  ⚠ #${depId} — not found`);
			allMet = false;
		} else if (dep.status === "done") {
			lines.push(`  ✓ #${dep.id} ${dep.title} — done`);
		} else {
			lines.push(`  ✗ #${dep.id} ${dep.title} — ${dep.status}`);
			allMet = false;
		}
	}

	lines.push("");
	lines.push(allMet ? "All dependencies met ✓ — task is ready to start" : "Some dependencies are not met ✗");

	return result(store, "check_dependencies", lines.join("\n"));
}

// ─── Dependency Warning for Start ────────────────────────────────

/**
 * Return a list of human-readable strings for unmet (non-done) dependencies.
 * Used by status.ts when starting a task to warn about blocking deps.
 */
export function getUnmetDependencies(store: TaskStore, taskId: number): string[] {
	const task = findTask(store, taskId);
	if (!task) return [];

	const unmet: string[] = [];
	for (const depId of task.dependsOn) {
		const dep = findTask(store, depId);
		if (dep && dep.status !== "done") {
			unmet.push(`#${dep.id} (${dep.title}) is ${dep.status}`);
		}
	}
	return unmet;
}
