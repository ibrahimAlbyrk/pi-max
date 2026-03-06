/**
 * Prioritizer — Suggest priority changes based on project structure
 *
 * Rule-based (no LLM call required). Evaluates the task graph and
 * returns suggestions for tasks whose priority should be raised.
 */

import type { TaskPriority, TaskStore } from "../types.js";

export interface PrioritySuggestion {
	taskId: number;
	title: string;
	currentPriority: TaskPriority;
	suggestedPriority: TaskPriority;
	reason: string;
}

/**
 * Compute priority suggestions by applying rule-based heuristics to the store.
 *
 * Rules:
 * 1. Tasks blocking 2+ others → suggest high/critical
 * 2. In-progress tasks running 2x+ over estimate → suggest high
 * 3. Tasks with all deps met but still todo and low priority → suggest medium
 */
export function calculatePrioritySuggestions(store: TaskStore): PrioritySuggestion[] {
	const suggestions: PrioritySuggestion[] = [];

	for (const task of store.tasks.filter((t) => t.status !== "done")) {
		// Rule 1: Tasks that block many others should be high priority
		const blockedCount = store.tasks.filter((t) => t.dependsOn.includes(task.id) && t.status !== "done").length;

		if (blockedCount >= 2 && task.priority !== "critical" && task.priority !== "high") {
			suggestions.push({
				taskId: task.id,
				title: task.title,
				currentPriority: task.priority,
				suggestedPriority: blockedCount >= 3 ? "critical" : "high",
				reason: `Blocks ${blockedCount} other tasks`,
			});
		}

		// Rule 2: Old in_progress tasks might need attention
		if (task.status === "in_progress" && task.startedAt) {
			const elapsed = Date.now() - new Date(task.startedAt).getTime();
			const estimatedMs = (task.estimatedMinutes ?? 60) * 60000;
			if (elapsed > estimatedMs * 2 && task.priority !== "critical") {
				suggestions.push({
					taskId: task.id,
					title: task.title,
					currentPriority: task.priority,
					suggestedPriority: "high",
					reason: `Running ${Math.round(elapsed / estimatedMs)}x over estimate`,
				});
			}
		}

		// Rule 3: Tasks with all dependencies met but still todo
		if (task.status === "todo" && task.dependsOn.length > 0) {
			const allDepsMet = task.dependsOn.every((depId) => {
				const dep = store.tasks.find((t) => t.id === depId);
				return dep?.status === "done";
			});
			if (allDepsMet && task.priority === "low") {
				suggestions.push({
					taskId: task.id,
					title: task.title,
					currentPriority: task.priority,
					suggestedPriority: "medium",
					reason: "All dependencies met — ready to start",
				});
			}
		}
	}

	return suggestions;
}
