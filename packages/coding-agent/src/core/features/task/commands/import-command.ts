/**
 * /task-import Command — Import tasks from Markdown file
 *
 * Usage:
 *   /task-import TASKS.md                  → auto-detect format, merge mode
 *   /task-import --format checklist todo.md → force checklist format
 */

import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import type { ExtensionAPI } from "../../../extensions/types.js";
import { applyMerge, formatMergePlan, planMerge } from "../import/merge.js";
import type { ImportFormat } from "../import/parser.js";
import { parseMarkdownTasks } from "../import/parser.js";
import type { TaskStore } from "../types.js";

export function registerImportCommand(pi: ExtensionAPI, getStore: () => TaskStore, onMutate: () => void): void {
	pi.registerCommand("task-import", {
		description: "Import tasks: /task-import [--format auto|tasks|checklist] <path>",
		handler: async (args, ctx) => {
			const store = getStore();

			if (!args?.trim()) {
				ctx.ui.notify("Usage: /task-import [--format <format>] <path>", "warning");
				return;
			}

			// Parse arguments
			const { format, filePath } = parseImportArgs(args);

			const fullPath = resolve(ctx.cwd, filePath);
			if (!existsSync(fullPath)) {
				ctx.ui.notify(`File not found: ${filePath}`, "error");
				return;
			}

			let content: string;
			try {
				content = readFileSync(fullPath, "utf-8");
			} catch (err) {
				ctx.ui.notify(`Failed to read file: ${err}`, "error");
				return;
			}

			const parsed = parseMarkdownTasks(content, format);

			if (parsed.length === 0) {
				ctx.ui.notify("No tasks found in file.", "warning");
				return;
			}

			// Determine import mode
			let replaceMode = false;

			if (ctx.hasUI) {
				if (store.tasks.length > 0) {
					const mode = await ctx.ui.select("Import mode:", [
						"Merge — add new, update existing by title",
						"Replace — clear all tasks, import fresh",
					]);
					if (!mode) return; // cancelled
					replaceMode = mode.startsWith("Replace");
				}
			}

			if (replaceMode) {
				// Replace: clear and import all
				store.tasks = [];
				store.nextTaskId = 1;
				store.activeTaskId = null;

				const fakePlan = planMerge([], parsed);
				const result = applyMerge(store, fakePlan);
				onMutate();
				ctx.ui.notify(`Replaced with ${result.created} tasks from ${filePath}`, "info");
			} else {
				// Merge: compute plan, show preview, apply
				const plan = planMerge(store.tasks, parsed);

				if (ctx.hasUI && (plan.updates.length > 0 || plan.creates.length > 0)) {
					const preview = formatMergePlan(plan);
					const total = plan.creates.length + plan.updates.length;
					const confirm = await ctx.ui.confirm(`Import ${total} changes?`, preview);
					if (!confirm) return;
				}

				const result = applyMerge(store, plan);
				onMutate();
				ctx.ui.notify(
					`Imported: ${result.created} new, ${result.updated} updated, ${plan.unchanged} unchanged`,
					"info",
				);
			}
		},
	});
}

function parseImportArgs(args: string): { format: ImportFormat; filePath: string } {
	const parts = args.trim().split(/\s+/);
	let format: ImportFormat = "auto";
	let filePath = "";

	for (let i = 0; i < parts.length; i++) {
		if (parts[i] === "--format" && i + 1 < parts.length) {
			const f = parts[i + 1];
			if (["auto", "tasks", "checklist"].includes(f)) {
				format = f as ImportFormat;
			}
			i++; // skip next
		} else {
			filePath = parts[i] ?? "";
		}
	}

	if (!filePath) filePath = "TASKS.md";

	return { format, filePath };
}
