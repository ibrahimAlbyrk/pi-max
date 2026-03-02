/**
 * /board — Kanban board overlay with direct task mutations
 *
 * Move and priority changes happen IN-PLACE inside the KanbanBoard
 * component (no overlay close/reopen = no flicker).
 * Only "detail" and "escape" close the overlay.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { TaskStore } from "../types.js";
import { KanbanBoard, type KanbanResult, type KanbanMutateCallback } from "../ui/kanban-board.js";
import { showTaskDetailOverlay } from "./task-detail-command.js";
import { findTask } from "../store.js";

export function registerBoardCommand(
	pi: ExtensionAPI,
	getStore: () => TaskStore,
	onMutate: () => void,
) {
	pi.registerCommand("board", {
		description: "Open interactive Kanban board",
		handler: async (_args: string | undefined, ctx: ExtensionContext) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("Kanban board requires interactive mode", "error");
				return;
			}

			const store = getStore();
			if (store.tasks.length === 0) {
				ctx.ui.notify("No tasks yet. Ask the agent to create some!", "info");
				return;
			}

			await runBoardLoop(store, ctx, onMutate);
		},
	});
}

async function runBoardLoop(
	store: TaskStore,
	ctx: ExtensionContext,
	onMutate: () => void,
): Promise<void> {
	let focusTaskId: number | undefined;

	// Called by KanbanBoard for in-place mutations (no overlay close)
	const handleMutate: KanbanMutateCallback = (action) => {
		if (action.type === "move") {
			ctx.ui.notify(`#${action.task.id}: ${action.oldStatus} → ${action.newStatus}`, "info");
		} else {
			ctx.ui.notify(`#${action.task.id}: priority ${action.oldPriority} → ${action.newPriority}`, "info");
		}
		onMutate();
	};

	while (true) {
		const result = await ctx.ui.custom<KanbanResult>(
			(tui, theme, _kb, done) => {
				return new KanbanBoard(tui, store, theme, (r) => done(r), handleMutate, focusTaskId);
			},
			{ overlay: true },
		);

		focusTaskId = undefined;

		if (!result) return; // Escape

		if (result.type === "detail") {
			const task = findTask(store, result.taskId);
			if (!task) continue;
			focusTaskId = task.id;
			const detailResult = await showTaskDetailOverlay(task, store, ctx);
			if (detailResult === "close") return;
			// "back" → reopen board with focus on the same task
			continue;
		}
	}
}
