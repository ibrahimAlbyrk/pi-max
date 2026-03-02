/**
 * Event Bus — Task event emission for inter-extension communication
 *
 * Provides typed task events that other extensions can listen to via
 * `pi.events.on("task:*", handler)`. This module wraps pi.events
 * with task-specific event types.
 *
 * Available events:
 *   task:created         — New task created
 *   task:updated         — Task fields updated
 *   task:deleted         — Task deleted
 *   task:status_changed  — Task status changed
 *   task:completed       — Task marked as done
 *   task:started         — Task moved to in_progress
 *   task:blocked         — Task blocked
 *   task:sprint_assigned — Task assigned to a sprint
 *   task:note_added      — Note added to task
 *   task:auto_started    — Task auto-started by file edit detection
 *
 * Usage from other extensions:
 *   pi.events.on("task:completed", (data) => {
 *     console.log(`Task #${data.task.id} completed!`);
 *   });
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { Task, TaskStatus, Sprint } from "../types.js";

// ─── Event Types ─────────────────────────────────────────────────

export interface TaskCreatedEvent {
	task: Task;
}

export interface TaskUpdatedEvent {
	task: Task;
	changes: Partial<Task>;
}

export interface TaskDeletedEvent {
	taskId: number;
	title: string;
}

export interface TaskStatusChangedEvent {
	task: Task;
	oldStatus: TaskStatus;
	newStatus: TaskStatus;
}

export interface TaskCompletedEvent {
	task: Task;
}

export interface TaskStartedEvent {
	task: Task;
}

export interface TaskBlockedEvent {
	task: Task;
	reason: string;
}

export interface TaskSprintAssignedEvent {
	task: Task;
	sprint: Sprint;
}

export interface TaskNoteAddedEvent {
	task: Task;
	noteText: string;
	author: "user" | "agent";
}

export interface TaskAutoStartedEvent {
	task: Task;
	filePath: string;
}

// ─── Event Name Constants ────────────────────────────────────────

export const TASK_EVENTS = {
	CREATED: "task:created",
	UPDATED: "task:updated",
	DELETED: "task:deleted",
	STATUS_CHANGED: "task:status_changed",
	COMPLETED: "task:completed",
	STARTED: "task:started",
	BLOCKED: "task:blocked",
	SPRINT_ASSIGNED: "task:sprint_assigned",
	NOTE_ADDED: "task:note_added",
	AUTO_STARTED: "task:auto_started",
} as const;

// ─── Emitter ─────────────────────────────────────────────────────

export class TaskEventEmitter {
	constructor(private pi: ExtensionAPI) {}

	created(task: Task): void {
		this.pi.events.emit(TASK_EVENTS.CREATED, { task } satisfies TaskCreatedEvent);
	}

	updated(task: Task, changes: Partial<Task>): void {
		this.pi.events.emit(TASK_EVENTS.UPDATED, { task, changes } satisfies TaskUpdatedEvent);
	}

	deleted(taskId: number, title: string): void {
		this.pi.events.emit(TASK_EVENTS.DELETED, { taskId, title } satisfies TaskDeletedEvent);
	}

	statusChanged(task: Task, oldStatus: TaskStatus, newStatus: TaskStatus): void {
		this.pi.events.emit(TASK_EVENTS.STATUS_CHANGED, {
			task, oldStatus, newStatus,
		} satisfies TaskStatusChangedEvent);

		// Also emit specific events for common transitions
		if (newStatus === "done") {
			this.completed(task);
		} else if (newStatus === "in_progress") {
			this.started(task);
		} else if (newStatus === "blocked") {
			this.blocked(task, task.notes.at(-1)?.text ?? "");
		}
	}

	completed(task: Task): void {
		this.pi.events.emit(TASK_EVENTS.COMPLETED, { task } satisfies TaskCompletedEvent);
	}

	started(task: Task): void {
		this.pi.events.emit(TASK_EVENTS.STARTED, { task } satisfies TaskStartedEvent);
	}

	blocked(task: Task, reason: string): void {
		this.pi.events.emit(TASK_EVENTS.BLOCKED, { task, reason } satisfies TaskBlockedEvent);
	}

	sprintAssigned(task: Task, sprint: Sprint): void {
		this.pi.events.emit(TASK_EVENTS.SPRINT_ASSIGNED, {
			task, sprint,
		} satisfies TaskSprintAssignedEvent);
	}

	noteAdded(task: Task, noteText: string, author: "user" | "agent"): void {
		this.pi.events.emit(TASK_EVENTS.NOTE_ADDED, {
			task, noteText, author,
		} satisfies TaskNoteAddedEvent);
	}

	autoStarted(task: Task, filePath: string): void {
		this.pi.events.emit(TASK_EVENTS.AUTO_STARTED, {
			task, filePath,
		} satisfies TaskAutoStartedEvent);
	}
}
