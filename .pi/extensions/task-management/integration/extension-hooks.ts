/**
 * Extension Hooks — Inter-extension communication patterns
 *
 * Provides hooks for other extensions to integrate with the task manager.
 * Currently supports:
 *   - Git checkpoint integration (auto-commit on task completion)
 *   - Plan mode integration (convert plan steps to tasks)
 *   - Custom automation triggers
 *
 * Other extensions can register listeners via pi.events:
 *
 *   pi.events.on("task:completed", async (data) => {
 *     // e.g., git commit, send notification, update dashboard
 *   });
 *
 *   pi.events.on("task:status_changed", async (data) => {
 *     // e.g., log to external tracker, update CI status
 *   });
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { TaskStore, Task } from "../types.js";
import { TASK_EVENTS, TaskEventEmitter } from "./event-bus.js";

// ─── Git Checkpoint Hook ─────────────────────────────────────────

/**
 * Register a listener that emits git-checkpoint events when tasks are completed.
 * If a `git-checkpoint` extension is present and listens on `task:completed`,
 * it can auto-commit with a meaningful message.
 */
export function registerGitCheckpointHook(pi: ExtensionAPI, getStore: () => TaskStore): void {
	pi.events.on(TASK_EVENTS.COMPLETED, (data: { task: Task }) => {
		const { task } = data;
		// Emit a generic "checkpoint" event that git extensions can consume
		pi.events.emit("checkpoint:request", {
			source: "task-management",
			message: `✅ Task #${task.id}: ${task.title}`,
			metadata: {
				taskId: task.id,
				taskTitle: task.title,
				taskPriority: task.priority,
			},
		});
	});
}

// ─── Sprint Completion Hook ──────────────────────────────────────

/**
 * Register a listener that fires when all tasks in an active sprint are done.
 * Can be used to trigger deployment pipelines or notifications.
 */
export function registerSprintCompletionHook(pi: ExtensionAPI, getStore: () => TaskStore): void {
	pi.events.on(TASK_EVENTS.COMPLETED, (data: { task: Task }) => {
		const store = getStore();
		const { task } = data;

		if (!task.sprintId) return;

		const sprint = store.sprints.find((s) => s.id === task.sprintId);
		if (!sprint || sprint.status !== "active") return;

		const sprintTasks = store.tasks.filter((t) => t.sprintId === sprint.id);
		const allDone = sprintTasks.every((t) => t.status === "done");

		if (allDone) {
			pi.events.emit("sprint:all_tasks_done", {
				sprint,
				taskCount: sprintTasks.length,
			});
		}
	});
}

// ─── Blocked Chain Detection Hook ────────────────────────────────

/**
 * When a task is completed, check if any blocked tasks can now be unblocked.
 * Emits "task:unblockable" for each task whose dependencies are now met.
 */
export function registerUnblockDetectionHook(pi: ExtensionAPI, getStore: () => TaskStore): void {
	pi.events.on(TASK_EVENTS.COMPLETED, (data: { task: Task }) => {
		const store = getStore();
		const completedId = data.task.id;

		for (const task of store.tasks) {
			if (task.status !== "blocked" && task.status !== "todo") continue;
			if (!task.dependsOn.includes(completedId)) continue;

			const allDepsMet = task.dependsOn.every((depId) => {
				const dep = store.tasks.find((t) => t.id === depId);
				return dep?.status === "done";
			});

			if (allDepsMet) {
				pi.events.emit("task:unblockable", {
					task,
					resolvedDependency: data.task,
				});
			}
		}
	});
}

// ─── Register All Hooks ──────────────────────────────────────────

/**
 * Convenience function to register all inter-extension hooks at once.
 */
export function registerAllHooks(pi: ExtensionAPI, getStore: () => TaskStore): void {
	registerGitCheckpointHook(pi, getStore);
	registerSprintCompletionHook(pi, getStore);
	registerUnblockDetectionHook(pi, getStore);
}
