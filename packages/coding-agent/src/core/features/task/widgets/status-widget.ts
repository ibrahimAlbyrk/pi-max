/**
 * Status Bar Widget — Task state indicators in the footer status area.
 *
 * Shows:
 *  - Active task indicator (task id, title, elapsed time)
 *  - Progress summary (done/total, in-progress count, blocked count)
 *  - Active sprint indicator when a sprint is running
 *
 * Designed for built-in use: no ExtensionContext dependency.
 * The caller provides a setStatus callback and a Theme instance.
 */

import type { Theme } from "../../../../modes/interactive/theme/theme.js";
import type { TaskStore } from "../types.js";
import { formatElapsed, truncate } from "../ui/helpers.js";

type SetStatusFn = (key: string, text: string | undefined) => void;

export class StatusWidget {
	constructor(
		private readonly setStatus: SetStatusFn,
		private readonly theme: Theme,
	) {}

	/**
	 * Refresh all status bar indicators from the current store state.
	 * Call this whenever the store changes.
	 */
	update(_store: TaskStore): void {
		// Disabled — info is already shown in the NextTasksComponent widget above the editor.
		// Clear any stale statuses so nothing lingers from previous state.
		this.setStatus("task-active", undefined);
		this.setStatus("task-progress", undefined);
		this.setStatus("task-sprint", undefined);
	}

	/**
	 * Set the active-task status indicator.
	 * Shows: "🔨 #<id> <title> <elapsed>"
	 * Clears when no active task.
	 */
	private updateActiveTask(store: TaskStore): void {
		if (!store.activeTaskId) {
			this.setStatus("task-active", undefined);
			return;
		}

		const task = store.tasks.find((t) => t.id === store.activeTaskId);
		if (!task) {
			this.setStatus("task-active", undefined);
			return;
		}

		const th = this.theme;
		let text = th.fg("accent", `🔨 #${task.id} ${truncate(task.title, 25)}`);

		if (task.startedAt) {
			const elapsed = Date.now() - new Date(task.startedAt).getTime();
			text += th.fg("dim", ` ${formatElapsed(elapsed)}`);
		}

		this.setStatus("task-active", text);
	}

	/**
	 * Set the progress summary status indicator.
	 * Shows: "✓<done>/<total> ●<in-progress> ⊘<blocked>"
	 * Clears when no tasks.
	 */
	private updateProgress(store: TaskStore): void {
		const total = store.tasks.length;
		if (total === 0) {
			this.setStatus("task-progress", undefined);
			return;
		}

		const th = this.theme;
		const done = store.tasks.filter((t) => t.status === "done").length;
		const inProgress = store.tasks.filter((t) => t.status === "in_progress").length;
		const blocked = store.tasks.filter((t) => t.status === "blocked").length;

		let text = th.fg("success", `✓${done}`) + th.fg("dim", "/") + th.fg("text", `${total}`);
		if (inProgress > 0) text += th.fg("accent", ` ●${inProgress}`);
		if (blocked > 0) text += th.fg("error", ` ⊘${blocked}`);

		this.setStatus("task-progress", text);
	}

	/**
	 * Set the active sprint status indicator.
	 * Shows: "⚡ <sprint name> (<done>/<total>)"
	 * Clears when no active sprint.
	 */
	private updateSprint(store: TaskStore): void {
		if (store.activeSprintId === null) {
			this.setStatus("task-sprint", undefined);
			return;
		}

		const sprint = store.sprints.find((s) => s.id === store.activeSprintId);
		if (!sprint) {
			this.setStatus("task-sprint", undefined);
			return;
		}

		const th = this.theme;
		const sprintTasks = store.tasks.filter((t) => t.sprintId === sprint.id);
		const done = sprintTasks.filter((t) => t.status === "done").length;
		const total = sprintTasks.length;

		const text = th.fg("accent", `⚡ ${truncate(sprint.name, 20)}`) + th.fg("dim", ` ${done}/${total}`);

		this.setStatus("task-sprint", text);
	}

	/**
	 * Enable full status display — shows active task, progress, and sprint.
	 * By default, update() clears all statuses (info already in widget above editor).
	 * Call enableFullStatus() to switch to showing all indicators instead.
	 */
	enableFullStatus(): void {
		this.update = (store: TaskStore): void => {
			this.updateActiveTask(store);
			this.updateProgress(store);
			this.updateSprint(store);
		};
	}

	/** Clear all task-related status indicators. */
	clear(): void {
		this.setStatus("task-active", undefined);
		this.setStatus("task-progress", undefined);
		this.setStatus("task-sprint", undefined);
	}
}
