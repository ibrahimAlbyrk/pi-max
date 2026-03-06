/**
 * /task-export Command — Export tasks to Markdown file
 *
 * Usage:
 *   /task-export                   → full format → TASKS.md
 *   /task-export summary           → summary format → TASKS.md
 *   /task-export full              → full format → TASKS.md
 *   /task-export full output.md    → full format → output.md
 */

import { existsSync, mkdirSync, statSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import type { ExtensionAPI } from "../../../extensions/types.js";
import { generateFullExport } from "../export/full-export.js";
import { generateSummaryExport } from "../export/summary-export.js";
import type { TaskStore } from "../types.js";

type ExportFormat = "summary" | "full";

const DEFAULT_PATH = "TASKS.md";

export function registerExportCommand(pi: ExtensionAPI, getStore: () => TaskStore): void {
	pi.registerCommand("task-export", {
		description: "Export tasks: /task-export [summary|full] [path]",
		handler: async (args, ctx) => {
			const store = getStore();

			if (store.tasks.length === 0) {
				ctx.ui.notify("No tasks to export.", "warning");
				return;
			}

			const parts = (args ?? "").trim().split(/\s+/).filter(Boolean);
			let format: ExportFormat = "full";
			let outputPath: string | undefined;

			if (parts.length > 0 && ["summary", "full"].includes(parts[0])) {
				format = parts[0] as ExportFormat;
				outputPath = parts[1];
			} else if (parts.length > 0) {
				outputPath = parts[0];
			}

			outputPath = outputPath ?? DEFAULT_PATH;

			// Generate content
			const content = format === "summary" ? generateSummaryExport(store) : generateFullExport(store);

			// If path is a directory, append default filename
			let fullPath = resolve(ctx.cwd, outputPath);
			if (existsSync(fullPath) && statSync(fullPath).isDirectory()) {
				fullPath = join(fullPath, DEFAULT_PATH);
			}
			try {
				mkdirSync(dirname(fullPath), { recursive: true });
				writeFileSync(fullPath, content, "utf-8");
				ctx.ui.notify(`Exported ${store.tasks.length} tasks to ${outputPath} (${format} format)`, "info");
			} catch (err) {
				ctx.ui.notify(`Export failed: ${err}`, "error");
			}
		},
	});
}
