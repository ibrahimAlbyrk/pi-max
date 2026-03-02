/**
 * /task-history Command — Export full history of a single task
 *
 * Usage:
 *   /task-history 5              → export task #5 history to TASK-5.md
 *   /task-history 5 output.md    → export to custom path
 */

import { writeFileSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { TaskStore } from "../types.js";
import { generateTaskHistory } from "../export/task-history.js";

export function registerTaskHistoryCommand(
	pi: ExtensionAPI,
	getStore: () => TaskStore,
): void {
	pi.registerCommand("task-history", {
		description: "Export task history: /task-history <id> [path]",
		handler: async (args: string | undefined, ctx: ExtensionContext) => {
			const store = getStore();

			if (!args?.trim()) {
				ctx.ui.notify("Usage: /task-history <id> [path]", "warning");
				return;
			}

			const parts = args.trim().split(/\s+/);
			const taskId = parseInt(parts[0]);

			if (isNaN(taskId)) {
				ctx.ui.notify(`Invalid task ID: ${parts[0]}`, "error");
				return;
			}

			const task = store.tasks.find((t) => t.id === taskId);
			if (!task) {
				ctx.ui.notify(`Task #${taskId} not found`, "error");
				return;
			}

			const outputPath = parts[1] || `TASK-${taskId}.md`;
			const content = generateTaskHistory(task, store);

			const fullPath = resolve(ctx.cwd, outputPath);
			try {
				mkdirSync(dirname(fullPath), { recursive: true });
				writeFileSync(fullPath, content, "utf-8");
				ctx.ui.notify(
					`Task #${taskId} history exported to ${outputPath}`,
					"info",
				);
			} catch (err) {
				ctx.ui.notify(`Export failed: ${err}`, "error");
			}
		},
	});
}
