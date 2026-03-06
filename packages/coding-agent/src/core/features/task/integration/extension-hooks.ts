/**
 * Extension Hooks — Integration side-effects for task events
 *
 * These are pure functions called directly by the feature setup (index.ts) when
 * the corresponding task events fire. They do NOT use pi.events.on() — instead,
 * the caller registers the hooks via session.onEvent() and invokes these functions.
 *
 * Pattern:
 *   session.onEvent("task:completed", (data) => {
 *     const { task } = data as TaskCompletedEvent;
 *     handleGitCheckpoint(emitter, task);
 *     handleSprintCompletion(emitter, store, task);
 *     handleUnblockDetection(emitter, store, task);
 *   });
 *
 * Hooks provided:
 *   handleGitCheckpoint      — Emit checkpoint:request when a task is completed
 *   handleSprintCompletion   — Emit sprint:all_tasks_done when every sprint task is done
 *   handleUnblockDetection   — Emit task:unblockable for tasks whose deps are now met
 *   handleTaskCompletionHooks — Convenience: call all three in order
 */

import type { Sprint, Task, TaskStore } from "../types.js";
import type { EventEmitter } from "./event-bus.js";

// ─── Checkpoint Event ────────────────────────────────────────────

export interface CheckpointRequestEvent {
	source: "task-management";
	message: string;
	metadata: {
		taskId: number;
		taskTitle: string;
		taskPriority: string;
	};
}

// ─── Sprint Completion Event ─────────────────────────────────────

export interface SprintAllTasksDoneEvent {
	sprint: Sprint;
	taskCount: number;
}

// ─── Unblockable Task Event ──────────────────────────────────────

export interface TaskUnblockableEvent {
	task: Task;
	resolvedDependency: Task;
}

// ─── Git Checkpoint Hook ─────────────────────────────────────────

/**
 * Emit a git-checkpoint event when a task is completed.
 * The `git-checkpoint` built-in (or any other consumer) can listen to
 * "checkpoint:request" on the session event bus to auto-commit.
 */
export function handleGitCheckpoint(emitter: EventEmitter, task: Task): void {
	const event: CheckpointRequestEvent = {
		source: "task-management",
		message: `Task #${task.id}: ${task.title}`,
		metadata: {
			taskId: task.id,
			taskTitle: task.title,
			taskPriority: task.priority,
		},
	};
	emitter.emit("checkpoint:request", event);
}

// ─── Sprint Completion Hook ──────────────────────────────────────

/**
 * Check whether all tasks in the completed task's sprint are now done.
 * If so, emit "sprint:all_tasks_done" so consumers can trigger deployment
 * pipelines, notifications, or auto-complete the sprint.
 *
 * Only fires when:
 *   - The task belongs to a sprint
 *   - That sprint is currently active
 *   - Every task assigned to that sprint is now done
 */
export function handleSprintCompletion(emitter: EventEmitter, store: TaskStore, task: Task): void {
	if (!task.sprintId) return;

	const sprint = store.sprints.find((s) => s.id === task.sprintId);
	if (!sprint || sprint.status !== "active") return;

	const sprintTasks = store.tasks.filter((t) => t.sprintId === sprint.id);
	const allDone = sprintTasks.length > 0 && sprintTasks.every((t) => t.status === "done");

	if (allDone) {
		const event: SprintAllTasksDoneEvent = {
			sprint,
			taskCount: sprintTasks.length,
		};
		emitter.emit("sprint:all_tasks_done", event);
	}
}

// ─── Unblock Detection Hook ──────────────────────────────────────

/**
 * When a task is completed, scan for blocked/todo tasks whose dependencies
 * are now fully met and emit "task:unblockable" for each one.
 *
 * Emits "task:unblockable" for each candidate so the feature (or the LLM
 * context injector) can surface them as next-up tasks.
 */
export function handleUnblockDetection(emitter: EventEmitter, store: TaskStore, completedTask: Task): void {
	for (const task of store.tasks) {
		if (task.status !== "blocked" && task.status !== "todo") continue;
		if (!task.dependsOn.includes(completedTask.id)) continue;

		const allDepsMet = task.dependsOn.every((depId) => {
			const dep = store.tasks.find((t) => t.id === depId);
			return dep?.status === "done";
		});

		if (allDepsMet) {
			const event: TaskUnblockableEvent = {
				task,
				resolvedDependency: completedTask,
			};
			emitter.emit("task:unblockable", event);
		}
	}
}

// ─── Combined Hook ───────────────────────────────────────────────

/**
 * Convenience function: call all completion hooks in order.
 * Call this from the feature setup's task:completed handler:
 *
 *   session.onEvent("task:completed", (data) => {
 *     const { task } = data as TaskCompletedEvent;
 *     handleTaskCompletionHooks(emitter, sc.store, task);
 *   });
 */
export function handleTaskCompletionHooks(emitter: EventEmitter, store: TaskStore, task: Task): void {
	handleGitCheckpoint(emitter, task);
	handleSprintCompletion(emitter, store, task);
	handleUnblockDetection(emitter, store, task);
}
