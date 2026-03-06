/**
 * Event Bus — Task event emission for inter-feature communication
 *
 * Provides typed task events that built-in features can listen to. Wraps a
 * generic EventEmitter (wired to session.emitEvent() at setup time) with
 * task-specific typed methods.
 *
 * Available events (see TASK_EVENTS):
 *   task:created         — New task created
 *   task:updated         — Task fields updated
 *   task:deleted         — Task deleted
 *   task:status_changed  — Task status changed
 *   task:completed       — Task marked as done
 *   task:started         — Task moved to in_progress
 *   task:blocked         — Task blocked with a reason
 *   task:sprint_assigned — Task assigned to a sprint
 *   task:note_added      — Note added to task
 *   task:auto_started    — Task auto-started by file edit detection
 */

import type {
	Sprint,
	Task,
	TaskAutoStartedEvent,
	TaskBlockedEvent,
	TaskCompletedEvent,
	TaskCreatedEvent,
	TaskDeletedEvent,
	TaskEventChannel,
	TaskNoteAddedEvent,
	TaskSprintAssignedEvent,
	TaskStartedEvent,
	TaskStatus,
	TaskStatusChangedEvent,
	TaskUpdatedEvent,
} from "../types.js";

export { TASK_EVENTS } from "../types.js";

// ─── Generic Event Emitter ───────────────────────────────────────

/**
 * Minimal event emission interface.
 * Wired to session.emitEvent() at feature setup time:
 *
 *   const emitter: EventEmitter = {
 *     emit: (event, data) => session.emitEvent(event, data),
 *   };
 */
export interface EventEmitter {
	emit(event: string, data: unknown): void;
}

// Re-export event data types so consumers can import from one place
export type {
	TaskCreatedEvent,
	TaskUpdatedEvent,
	TaskDeletedEvent,
	TaskStatusChangedEvent,
	TaskCompletedEvent,
	TaskStartedEvent,
	TaskBlockedEvent,
	TaskSprintAssignedEvent,
	TaskNoteAddedEvent,
	TaskAutoStartedEvent,
};

// ─── TaskEventEmitter ────────────────────────────────────────────

/**
 * Typed wrapper around a generic EventEmitter.
 * Implements TaskEventChannel (defined in types.ts) so it can be stored
 * as `taskEvents: TaskEventChannel` in SharedContext.
 *
 * Usage:
 *   const taskEvents = new TaskEventEmitter({
 *     emit: (event, data) => session.emitEvent(event, data),
 *   });
 *   taskEvents.completed(task);
 */
export class TaskEventEmitter implements TaskEventChannel {
	constructor(private readonly emitter: EventEmitter) {}

	created(task: Task): void {
		const event: TaskCreatedEvent = { task };
		this.emitter.emit("task:created", event);
	}

	updated(task: Task, changes: Partial<Task>): void {
		const event: TaskUpdatedEvent = { task, changes };
		this.emitter.emit("task:updated", event);
	}

	deleted(taskId: number, title: string): void {
		const event: TaskDeletedEvent = { taskId, title };
		this.emitter.emit("task:deleted", event);
	}

	statusChanged(task: Task, oldStatus: TaskStatus, newStatus: TaskStatus): void {
		const event: TaskStatusChangedEvent = { task, oldStatus, newStatus };
		this.emitter.emit("task:status_changed", event);

		// Also fire specific convenience events for common transitions
		if (newStatus === "done") {
			this.completed(task);
		} else if (newStatus === "in_progress") {
			this.started(task);
		} else if (newStatus === "blocked") {
			// Use last note text as the reason if available, otherwise empty string
			this.blocked(task, task.notes.at(-1)?.text ?? "");
		}
	}

	completed(task: Task): void {
		const event: TaskCompletedEvent = { task };
		this.emitter.emit("task:completed", event);
	}

	started(task: Task): void {
		const event: TaskStartedEvent = { task };
		this.emitter.emit("task:started", event);
	}

	blocked(task: Task, reason: string): void {
		const event: TaskBlockedEvent = { task, reason };
		this.emitter.emit("task:blocked", event);
	}

	sprintAssigned(task: Task, sprint: Sprint): void {
		const event: TaskSprintAssignedEvent = { task, sprint };
		this.emitter.emit("task:sprint_assigned", event);
	}

	noteAdded(task: Task, noteText: string, author: "user" | "agent"): void {
		const event: TaskNoteAddedEvent = { task, noteText, author };
		this.emitter.emit("task:note_added", event);
	}

	autoStarted(task: Task, filePath: string): void {
		const event: TaskAutoStartedEvent = { task, filePath };
		this.emitter.emit("task:auto_started", event);
	}
}
