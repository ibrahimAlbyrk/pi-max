/**
 * Status Bar Widgets — Active task indicator + progress summary
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { TaskStore } from "../types.js";
import { formatElapsed } from "../store.js";
import { truncate } from "../ui/helpers.js";

export function updateStatusWidgets(store: TaskStore, ctx: ExtensionContext): void {
	// Disabled — info already shown above the input area
	ctx.ui.setStatus("task-active", undefined);
	ctx.ui.setStatus("task-progress", undefined);
}

function updateActiveTaskStatus(store: TaskStore, ctx: ExtensionContext): void {
	if (!store.activeTaskId) {
		ctx.ui.setStatus("task-active", undefined);
		return;
	}

	const task = store.tasks.find((t) => t.id === store.activeTaskId);
	if (!task) {
		ctx.ui.setStatus("task-active", undefined);
		return;
	}

	const th = ctx.ui.theme;
	let text = th.fg("accent", `🔨 #${task.id} ${truncate(task.title, 25)}`);

	if (task.startedAt) {
		const elapsed = Date.now() - new Date(task.startedAt).getTime();
		text += th.fg("dim", ` ${formatElapsed(elapsed)}`);
	}

	ctx.ui.setStatus("task-active", text);
}

function updateProgressStatus(store: TaskStore, ctx: ExtensionContext): void {
	const total = store.tasks.length;
	if (total === 0) {
		ctx.ui.setStatus("task-progress", undefined);
		return;
	}

	const th = ctx.ui.theme;
	const done = store.tasks.filter((t) => t.status === "done").length;
	const inProgress = store.tasks.filter((t) => t.status === "in_progress").length;
	const blocked = store.tasks.filter((t) => t.status === "blocked").length;

	let text = th.fg("success", `✓${done}`) + th.fg("dim", "/") + th.fg("text", `${total}`);
	if (inProgress > 0) text += th.fg("accent", ` ●${inProgress}`);
	if (blocked > 0) text += th.fg("error", ` ⊘${blocked}`);

	ctx.ui.setStatus("task-progress", text);
}
